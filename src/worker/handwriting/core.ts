import type { Env } from "../env";
import { hex, hmacSha256, randomId } from "../crypto";
import { HttpError } from "../http";
import { getReviewer } from "../db";
import { readSession } from "../auth/session";

export const prefix = "/api/handwriting-intake";
export const withdrawalEmail = "heocrproject@gmail.com";
export const idPattern = /^[a-z0-9_-]{1,100}$/;
export const digestPattern = /^[0-9a-f]{64}$/;
export type Role = "intake" | "operator" | "reader" | "adjudicator" | "eval";
export type Language = "en" | "he";
type Wording = { version: string; text: string; sha256: string };
export type Slot = { prompt: string; capture: "phone" | "scanner"; pen: "ballpoint" | "gel_rollerball" | "felt_fineline"; paper: "plain" | "ruled" };
type Configuration = {
  campaign: string;
  writerConsent: Record<Language, Wording>;
  readerConsent: Record<Language, Wording>;
  retentionNotice: Record<Language, string>;
  prompts: Record<string, { text: string; sha256: string; rights: string }>;
  slots: Record<string, Slot>;
  access: Record<Role, string[]>;
  launch?: { evalSampling: string; evalSplit: string; leadApproval: string };
};
export type Intake = {
  request: Request;
  env: Env;
  db: D1Database;
  media: R2Bucket;
  control: R2Bucket;
  config: Configuration;
  now: number;
  secret: string;
};
export type Page = {
  id: string; slot: string; writer: string; writer_account: string; source: string; receipt: string;
  prompt_hash: string; current_version: string | null; withdrawn: number;
};
export type Version = {
  id: string; page: string; parent: string | null; sha: string; mime: string; width: number; height: number;
  state: string; geometry: string | null; split: string;
};

export const notFound = () => new HttpError(404, "not_found");
export const invalid = () => new HttpError(400, "invalid_intake_input");
export const conflict = () => new HttpError(409, "intake_state_changed");
export const sha = async (value: string | Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value));
export const newId = () => randomId("", 16);
export const isString = (x: unknown): x is string => typeof x === "string";
export function language(value: unknown): Language {
  if (value !== "he" && value !== "en") throw invalid();
  return value;
}
export function inputId(value: unknown): string {
  if (!isString(value) || !idPattern.test(value)) throw invalid();
  return value;
}

export async function intakeContext(request: Request, env: Env): Promise<Intake> {
  const origin = new URL(request.url);
  const live = env.ENVIRONMENT === "production" && origin.origin === "https://review.heocr.org";
  const local = env.ENVIRONMENT === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((!live && !local) || env.HANDWRITING_INTAKE_ENABLED !== "1" || !env.HANDWRITING_DB || !env.HANDWRITING_MEDIA ||
    !env.HANDWRITING_CONTROL || !env.HANDWRITING_KEY || env.HANDWRITING_KEY.length < 32) throw notFound();
  const stored = await env.HANDWRITING_CONTROL.get("configuration.json");
  if (!stored) throw notFound();
  const config = await stored.json<Configuration>();
  if (!isString(config?.campaign) || !idPattern.test(config.campaign) || !config.access ||
    !config.slots || !config.prompts || (live && ![config.launch?.evalSampling, config.launch?.evalSplit, config.launch?.leadApproval]
    .every(value => typeof value === "string" && value.trim() !== ""))) throw notFound();
  return { request, env, db: env.HANDWRITING_DB, media: env.HANDWRITING_MEDIA, control: env.HANDWRITING_CONTROL,
    config, now: Date.now(), secret: env.HANDWRITING_KEY };
}

export async function asReviewer(c: Intake, ...allowed: Role[]) {
  const id = await readSession(c.env, c.request, c.now);
  const row = id ? await getReviewer(c.env.DB, id) : null;
  if (!id || !row || row.blocked || !allowed.some(role => Array.isArray(c.config.access[role]) && c.config.access[role].includes(id))) throw notFound();
  return id;
}

export const keyFor = (c: Intake, key: string) => c.config.campaign + "/" + key;
export const mediaPath = (c: Intake, page: string, child = "") => keyFor(c, "pages/" + page + "/" + child);
export const withdrawn = async (c: Intake, page: string) => !!await c.control.head(keyFor(c, "withdrawals/" + page));
export async function activePage(c: Intake, id: string): Promise<Page> {
  const page = await c.db.prepare("SELECT * FROM hw_pages WHERE id=? AND withdrawn=0").bind(id).first<Page>();
  if (!page || await withdrawn(c, id)) throw notFound();
  return page;
}

export async function activeVersion(c: Intake, page: Page, id: string): Promise<Version> {
  if (page.current_version !== id) throw notFound();
  const version = await c.db.prepare("SELECT * FROM hw_versions WHERE id=? AND page=? AND state<>'retired'").bind(id, page.id).first<Version>();
  if (!version) throw notFound();
  return version;
}

export async function privateCode(c: Intake, domain: string, value: string) {
  return hex(await hmacSha256(c.secret, c.config.campaign + ":" + domain + ":" + value));
}

export async function wording(c: Intake, target: "writerConsent" | "readerConsent", lang: Language) {
  const record = c.config[target]?.[lang];
  if (!record?.text || !idPattern.test(record.version) || !digestPattern.test(record.sha256) ||
    await sha(record.text) !== record.sha256 || !c.config.retentionNotice?.[lang]) throw notFound();
  return record;
}

export async function slotFor(c: Intake, slug: string) {
  const slot = Object.hasOwn(c.config.slots, slug) ? c.config.slots[slug] : undefined;
  const packet = slot && Object.hasOwn(c.config.prompts, slot.prompt) ? c.config.prompts[slot.prompt] : undefined;
  if (!slot || !packet?.text || !packet.rights || !digestPattern.test(packet.sha256) ||
    await sha(packet.text) !== packet.sha256 || packet.text.trimEnd().split("\n").length !== 10 ||
    !["phone", "scanner"].includes(slot.capture) || !["ballpoint", "gel_rollerball", "felt_fineline"].includes(slot.pen) ||
    !["plain", "ruled"].includes(slot.paper)) throw notFound();
  return { slot, packet };
}

export async function readBytes(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit) throw new HttpError(413, "body_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, "body_too_large");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}

export async function body(c: Intake, limit = 16_384): Promise<Record<string, unknown>> {
  if (!c.request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "json_required");
  const bytes = await readBytes(c.request, limit);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

export async function putMedia(c: Intake, page: string, name: string, data: Uint8Array) {
  if (await withdrawn(c, page)) throw notFound();
  const key = mediaPath(c, page, name);
  await c.media.put(key, data);
  if (await withdrawn(c, page)) {
    await c.media.delete(key);
    throw notFound();
  }
}

export async function erasePrefix(c: Intake, prefixPath: string) {
  // List fresh on each pass so no cursor can skip keys after a deletion.
  for (;;) {
    const { objects } = await c.media.list({ prefix: prefixPath });
    if (!objects.length) return;
    await c.media.delete(objects.map(o => o.key));
  }
}

export async function mediaResponse(c: Intake, page: string, name: string, mime: string, expectedSha?: string) {
  if (await withdrawn(c, page)) throw notFound();
  const object = await c.media.get(mediaPath(c, page, name));
  if (!object || await withdrawn(c, page)) throw notFound();
  let asset: ReadableStream | ArrayBuffer = object.body;
  if (expectedSha) {
    const verified = await object.arrayBuffer();
    if (await sha(new Uint8Array(verified)) !== expectedSha || await withdrawn(c, page)) throw notFound();
    asset = verified;
  }
  return new Response(asset, { headers: {
    "content-type": mime, "cache-control": "private, no-store", "cdn-cache-control": "no-store",
    "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer",
  } });
}
