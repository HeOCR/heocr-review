import {
  CAPTURE_API, CAPTURE_DIGEST, CAPTURE_FORM, captureFile, captureLog, captureRoot, captureRoster,
  type CaptureLog, type CapturePage, type CaptureRoster, type CaptureSlot,
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
type Receipt = {
  sha256: string;
  mime: string;
  bytes: number;
  filename: string;
  uploaded_at: string;
  log: CaptureLog;
};
type SlotRecord = { page_id: string; slot: CaptureSlot; revisions: Receipt[] };
type Intake = { bucket: R2Bucket; roster: CaptureRoster; pin: string; root: string };

export function isCapturePath(path: string) {
  return path === CAPTURE_FORM || path.startsWith(CAPTURE_FORM + "/") || path.startsWith("/api/registered-captures/");
}

async function intake(request: Request, env: Env, now: number): Promise<Intake> {
  const pin = env.REGISTERED_CAPTURE_ROSTER_SHA256;
  const bucket = env.RESTRICTED_REFERENCE_MEDIA;
  if (env.REGISTERED_CAPTURE_ENABLED !== "1" || !pin || !CAPTURE_DIGEST.test(pin) || !bucket) throw new HttpError(404, "not_found");
  const id = await readSession(env, request, now);
  if (!id || !referenceReviewerAllowed(env, new URL(request.url), id)) throw new HttpError(404, "not_found");
  const reviewer = await getReviewer(env.DB, id);
  if (!reviewer || reviewer.blocked) throw new HttpError(404, "not_found");
  const root = captureRoot(pin);
  const object = await bucket.get(root + "/roster.json");
  if (!object || object.size > 64 * 1024) throw new HttpError(404, "not_found");
  const bytes = await object.arrayBuffer();
  if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== pin) throw new HttpError(404, "not_found");
  const roster = captureRoster(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
  return { bucket, roster, pin, root };
}

async function readSlot(c: Intake, page: CapturePage, slot: CaptureSlot) {
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

async function status(c: Intake) {
  const pages = [];
  // Sequential per page keeps bucket fan-out bounded even for the full capture roster.
  for (const page of c.roster.pages) {
    const slots = await Promise.all(page.slots.map(async assignment => {
      const { data } = await readSlot(c, page, assignment.slot);
      const current = data.revisions.at(-1);
      return { ...assignment, current: current ? { sha256: current.sha256, filename: current.filename } : null };
    }));
    pages.push({ page_id: page.page_id, slots });
  }
  return json({ roster_sha256: c.pin, pages });
}

function captureLogHeader(request: Request, retake: boolean) {
  try {
    const header = request.headers.get("x-capture-log");
    return header && header.length <= 8192 ? captureLog(JSON.parse(decodeURIComponent(header)), retake) : null;
  } catch { return null; }
}

async function upload(c: Intake, request: Request, now: number) {
  assertSameOrigin(request);
  if (request.headers.get("x-capture-roster") !== c.pin) throw new HttpError(409, "capture_roster_changed");
  const filename = request.headers.get("x-capture-filename") ?? "";
  const match = captureFile(c.roster, filename);
  if (!match) throw new HttpError(400, "capture_filename_unregistered");
  const { page, assignment, ext } = match;
  const { slot } = assignment;
  const replaces = request.headers.get("x-capture-replaces");
  if (replaces !== null && !CAPTURE_DIGEST.test(replaces)) throw new HttpError(400, "capture_invalid_log");
  const log = captureLogHeader(request, replaces !== null);
  if (!log) throw new HttpError(400, "capture_invalid_log");
  const bytes = await readBytes(request, maxCaptureBytes, "capture_invalid_image");
  const mime = captureImageType(bytes, ext);
  if (!mime) throw new HttpError(415, "capture_invalid_image");
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const previous = await readSlot(c, page, slot);
  const current = previous.data.revisions.at(-1);
  const result = (receipt: Receipt, code: number) => json({
    page_id: page.page_id, slot, sha256: receipt.sha256, filename: receipt.filename, revisions: previous.data.revisions.length,
  }, code);
  if (current?.sha256 === sha256) return result(current, 200);
  if ((current?.sha256 ?? null) !== replaces || previous.data.revisions.some(r => r.sha256 === sha256)) {
    throw new HttpError(409, "capture_slot_changed");
  }
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
  const receipt = { sha256, mime, bytes: bytes.length, filename, uploaded_at: new Date(now).toISOString(), log };
  previous.data.revisions.push(receipt);
  const saved = await c.bucket.put(previous.key, JSON.stringify(previous.data), {
    onlyIf: previous.etag ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
  });
  if (!saved) {
    const updated = await readSlot(c, page, slot);
    if (updated.data.revisions.at(-1)?.sha256 !== sha256) throw new HttpError(409, "capture_slot_changed");
    return result(receipt, 200);
  }
  return result(receipt, 201);
}

export async function registeredCaptures(request: Request, env: Env, path: string) {
  try {
    const now = Date.now();
    const c = await intake(request, env, now);
    if (request.method === "GET" && (path === CAPTURE_FORM || path === CAPTURE_FORM + "/")) return captureForm();
    if (request.method === "GET" && path === CAPTURE_API) return await status(c);
    if (request.method === "POST" && path === CAPTURE_API + "/upload") return await upload(c, request, now);
    throw new HttpError(404, "not_found");
  } catch (error) {
    // Provider errors may include private keys and log fields.
    return error instanceof HttpError ? errorResponse(error) : json({ error: "capture_unavailable" }, 503);
  }
}
