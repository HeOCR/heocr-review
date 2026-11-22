import {
  CAPTURE_API, CAPTURE_DIGEST, CAPTURE_FORM, captureLog, captureRoot, captureRoster,
  formCapturePaths, formCaptureRoot, formCaptureRoster, formCapturePacks,
  TRAIN_CAPTURE_API, TRAIN_CAPTURE_FORM, trainCaptureRoot, trainCaptureRoster,
  type CaptureLog, type FormCapturePack,
} from "../shared/registered-captures";
import { readSession } from "./auth/session";
import { captureImageType } from "./capture-image";
import { hex } from "./crypto";
import { getReviewer } from "./db";
import type { Env } from "./env";
import { HttpError, assertSameOrigin, errorResponse, json, readBytes } from "./http";
import { referenceReviewerAllowed } from "./restricted_reference";
import { captureForm } from "./registered-capture-form";

const maxCaptureBytes = 24 * 1024 * 1024;
const pagesPerRequest = 11;
type Scope = "eval" | "train" | FormCapturePack;
const routes = [
  { scope: "eval", form: CAPTURE_FORM, api: CAPTURE_API },
  { scope: "train", form: TRAIN_CAPTURE_FORM, api: TRAIN_CAPTURE_API },
  ...formCapturePacks.map(scope => ({ scope, ...formCapturePaths[scope] })),
] as const;
type Receipt = {
  sha256: string;
  mime: string;
  bytes: number;
  filename: string;
  device?: "A" | "B";
  uploaded_at: string;
  log: CaptureLog;
};
type SlotRecord = { page_id: string; slot: string; revisions: Receipt[] };
type Intake = {
  bucket: R2Bucket;
  pages: { page_id: string; slots: { slot: string; condition: string }[] }[];
  pin: string;
  root: string;
  scope: Scope;
  train: boolean;
  scopeClaims: R2Bucket;
};

export function isCapturePath(path: string) {
  return path === CAPTURE_FORM || path.startsWith(CAPTURE_FORM + "/") || path.startsWith("/api/registered-captures/");
}

async function intake(request: Request, env: Env, now: number, scope: Scope): Promise<Intake> {
  const settings = {
    eval: [env.REGISTERED_CAPTURE_ENABLED, env.REGISTERED_CAPTURE_ROSTER_SHA256],
    train: [env.TRAIN_CAPTURE_ENABLED, env.TRAIN_CAPTURE_ROSTER_SHA256],
    "TRN-FM01": [env.FM01_CAPTURE_ENABLED, env.FM01_CAPTURE_ROSTER_SHA256],
    "TRN-FM01-G": [env.FM01_G_CAPTURE_ENABLED, env.FM01_G_CAPTURE_ROSTER_SHA256],
  };
  const [enabled, pin] = settings[scope];
  const train = scope !== "eval";
  const scopeClaims = env.RESTRICTED_REFERENCE_MEDIA;
  const bucket = train ? env.TRAIN_CAPTURE_MEDIA : scopeClaims;
  if (enabled !== "1" || !pin || !CAPTURE_DIGEST.test(pin) || !bucket || !scopeClaims) throw new HttpError(404, "not_found");
  const id = await readSession(env, request, now);
  if (!id || !referenceReviewerAllowed(env, new URL(request.url), id)) throw new HttpError(404, "not_found");
  const reviewer = await getReviewer(env.DB, id);
  if (!reviewer || reviewer.blocked) throw new HttpError(404, "not_found");
  const root = scope === "eval" ? captureRoot(pin) : scope === "train" ? trainCaptureRoot(pin) : formCaptureRoot(scope, pin);
  const object = await bucket.get(root + "/roster.json");
  if (!object || object.size > 64 * 1024) throw new HttpError(404, "not_found");
  if (train && await scopeClaims.head(root + "/roster.json")) throw new HttpError(404, "not_found");
  const bytes = await object.arrayBuffer();
  if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== pin) throw new HttpError(404, "not_found");
  const roster: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  const checked = scope === "eval" ? captureRoster(roster) :
    scope === "train" ? trainCaptureRoster(roster) : formCaptureRoster(roster, scope);
  return { bucket, pages: checked.pages, pin, root, scope, train, scopeClaims };
}

async function readSlot(c: Intake, page: Intake["pages"][number], slot: string) {
  const key = c.root + "/slots/" + page.page_id + "/" + slot + ".json";
  const object = await c.bucket.get(key);
  if (object) {
    const data = await object.json<SlotRecord>();
    if (data.page_id !== page.page_id || data.slot !== slot || !Array.isArray(data.revisions) || data.revisions.length === 0 ||
      data.revisions.some(r => typeof r?.sha256 !== "string" || !CAPTURE_DIGEST.test(r.sha256))) throw new Error("invalid slot record");
    return { key, data, etag: object.etag };
  }
  return { key, data: { page_id: page.page_id, slot, revisions: [] as Receipt[] }, etag: null };
}

async function status(c: Intake, url: URL) {
  const cursor = url.searchParams.get("cursor") ?? "0";
  const start = Number(cursor);
  if (!/^(0|[1-9][0-9]?)$/.test(cursor) || start % pagesPerRequest || start >= c.pages.length) {
    throw new HttpError(400, "capture_invalid_cursor");
  }
  const pages = [];
  for (const page of c.pages.slice(start, start + pagesPerRequest)) {
    const slots = await Promise.all(page.slots.map(async assignment => {
      const { data } = await readSlot(c, page, assignment.slot);
      const current = data.revisions.at(-1);
      return { ...assignment,
        current: current ? { sha256: current.sha256, filename: current.filename } : null };
    }));
    pages.push({ page_id: page.page_id, slots });
  }
  const end = start + pages.length;
  return json({ roster_sha256: c.pin, pages, next: end < c.pages.length ? end : null });
}

function captureLogHeader(request: Request, retake: boolean) {
  try {
    const header = request.headers.get("x-capture-log");
    return header && header.length <= 8192 ? captureLog(JSON.parse(decodeURIComponent(header)), retake) : null;
  } catch { return null; }
}

// Private, digest-only reservation across packs. A rename or concurrent upload
// cannot reserve the same camera bytes in more than one pack.
async function claimCaptureScope(c: Intake, sha256: string) {
  const key = "phone-capture-scope/v1/" + sha256;
  const scope = c.scope;
  const claim = await c.scopeClaims.put(key, "", {
    onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { scope },
  });
  if (!claim && (await c.scopeClaims.head(key))?.customMetadata?.scope !== scope) {
    throw new HttpError(409, "capture_bytes_already_used");
  }
}

async function upload(c: Intake, request: Request, now: number) {
  assertSameOrigin(request);
  if (request.headers.get("x-capture-roster") !== c.pin) throw new HttpError(409, "capture_roster_changed");
  const page = c.pages.find(p => p.page_id === request.headers.get("x-capture-page"));
  const slot = request.headers.get("x-capture-slot");
  const device = request.headers.get("x-capture-device");
  if (!page || !slot || !page.slots.some(s => s.slot === slot) ||
    (c.train ? device !== "A" && device !== "B" : device !== null)) throw new HttpError(400, "capture_slot_unregistered");
  let filename: string;
  try {
    const encoded = request.headers.get("x-capture-filename") ?? "";
    if (encoded.length > 2048) throw new Error();
    filename = decodeURIComponent(encoded);
    if (!filename.trim() || filename.length > 255 || /[/\\\p{Cc}\p{Cf}]/u.test(filename)) throw new Error();
  } catch { throw new HttpError(400, "capture_invalid_filename"); }
  const replaces = request.headers.get("x-capture-replaces");
  if (replaces !== null && !CAPTURE_DIGEST.test(replaces)) throw new HttpError(400, "capture_invalid_log");
  const log = captureLogHeader(request, replaces !== null);
  if (!log) throw new HttpError(400, "capture_invalid_log");
  const bytes = await readBytes(request, maxCaptureBytes, "capture_invalid_image");
  const mime = captureImageType(bytes, c.train);
  if (!mime) throw new HttpError(415, "capture_invalid_image");
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const previous = await readSlot(c, page, slot);
  const current = previous.data.revisions.at(-1);
  const result = (receipt: Receipt, code: number, revisions = previous.data.revisions.length) => json({
    page_id: page.page_id, slot, sha256: receipt.sha256, filename: receipt.filename,
    ...(receipt.device ? { device: receipt.device } : {}), revisions,
  }, code);
  if (current?.sha256 === sha256) {
    if (current.device && current.device !== device) throw new HttpError(409, "capture_slot_changed");
    return result(current, 200);
  }
  if ((current?.sha256 ?? null) !== replaces || previous.data.revisions.some(r => r.sha256 === sha256)) {
    throw new HttpError(409, "capture_slot_changed");
  }
  await claimCaptureScope(c, sha256);
  const claim = page.page_id + "/" + slot;
  const key = c.root + "/originals/" + sha256;
  const created = await c.bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { slot: claim },
    httpMetadata: { contentType: mime, cacheControl: "private, no-store" },
  });
  if (!created) {
    const stored = await c.bucket.head(key);
    if (!stored || stored.size !== bytes.length || stored.customMetadata?.slot !== claim) throw new HttpError(409, "capture_bytes_already_used");
  }
  const receipt: Receipt = { sha256, mime, bytes: bytes.length, filename,
    ...(device === "A" || device === "B" ? { device } : {}), uploaded_at: new Date(now).toISOString(), log };
  previous.data.revisions.push(receipt);
  const saved = await c.bucket.put(previous.key, JSON.stringify(previous.data), {
    onlyIf: previous.etag ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
  });
  if (!saved) {
    const updated = await readSlot(c, page, slot);
    const winner = updated.data.revisions.at(-1);
    if (winner?.sha256 !== sha256 || winner.device !== receipt.device) throw new HttpError(409, "capture_slot_changed");
    return result(winner, 200, updated.data.revisions.length);
  }
  return result(receipt, 201);
}

export async function registeredCaptures(request: Request, env: Env, path: string) {
  try {
    const now = Date.now();
    const route = routes.find(({ form, api }) =>
      path === form || path === form + "/" || path === api || path === api + "/upload");
    if (!route) throw new HttpError(404, "not_found");
    const { form, api, scope } = route;
    const isForm = request.method === "GET" && (path === form || path === form + "/");
    const isStatus = request.method === "GET" && path === api;
    const isUpload = request.method === "POST" && path === api + "/upload";
    if (!isForm && !isStatus && !isUpload) throw new HttpError(404, "not_found");
    const c = await intake(request, env, now, scope);
    if (isForm) return captureForm(api, c.train, scope === "eval" || scope === "train" ? undefined : scope);
    if (isStatus) return await status(c, new URL(request.url));
    if (isUpload) return await upload(c, request, now);
    throw new HttpError(404, "not_found");
  } catch (error) {
    // Provider errors may include private keys and log fields.
    return error instanceof HttpError ? errorResponse(error) : json({ error: "capture_unavailable" }, 503);
  }
}
