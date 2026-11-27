import { CAPTURE_BATCH_PREFIX, CAPTURE_DIGEST } from "../shared/registered-captures";
import { PRIVATE_IMAGE_KEY } from "../shared/media";
import { isRestrictedDraftVerification, restrictedStaticDirectory } from "../tasks/restricted_reference";
import { isReferenceProofread, PROOFREAD_PREFIX } from "../tasks/reference_proofread";
import type { BatchRecord, StoredImage } from "../tasks/types";
import type { Env } from "./env";
import { HttpError } from "./http";

export const RESTRICTED_MEDIA_PATH = "/api/restricted-media/v1";

const ISSUER_DRAFT_BATCH_PREFIX = "private-ref-draft-";

function sweepPinField(id: string) {
  if (id.startsWith(CAPTURE_BATCH_PREFIX)) return "capture_roster_sha256";
  if (id.startsWith(ISSUER_DRAFT_BATCH_PREFIX)) return "items_sha256";
  return null;
}

export function draftSweepPin(batch: BatchRecord) {
  const field = sweepPinField(batch.id);
  if (!field || !isRestrictedDraftVerification(batch)) return null;
  const digest = batch.source[field];
  return typeof digest === "string" && CAPTURE_DIGEST.test(digest) ? { field, digest } : null;
}

function issuerRegistryPin(config: string | undefined, batchId: string): string | undefined {
  if (!config) return undefined;
  try {
    const registry: unknown = JSON.parse(config);
    if (!registry || typeof registry !== "object" || Array.isArray(registry)) return undefined;
    if (!Object.hasOwn(registry, batchId)) return undefined;
    const digest = (registry as Record<string, unknown>)[batchId];
    return typeof digest === "string" && CAPTURE_DIGEST.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}

export function canReadReference(env: Env, url: URL, reviewerId: string, batch: BatchRecord): boolean {
  if (batch.id.startsWith(PROOFREAD_PREFIX) && !isReferenceProofread(batch)) return false;
  if (sweepPinField(batch.id)) {
    const pin = draftSweepPin(batch);
    if (!pin) return false;
    const expected = pin.field === "capture_roster_sha256" ? env.REGISTERED_CAPTURE_ROSTER_SHA256 :
      issuerRegistryPin(env.RATIFIED_ISSUER_SWEEP_PINS, batch.id);
    if (pin.digest !== expected) return false;
  }
  if (!batch.restrictedReference) {
    // Existing legacy data stays in D1. On deployment it cannot be served until its private roster is installed.
    return env.ENVIRONMENT === "development" || !restrictedStaticDirectory(batch.id);
  }
  if (!["line_verify", "page_review"].includes(batch.taskType)) return false;
  return referenceReviewerAllowed(env, url, reviewerId);
}

export function referenceReviewerAllowed(env: Env, url: URL, reviewerId: string): boolean {
  const host = url.origin === "https://review.heocr.org" ||
    (env.ENVIRONMENT === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const allowed = env.RESTRICTED_REFERENCE_REVIEWER_ID ?? "";
  return host && !!env.RESTRICTED_REFERENCE_MEDIA && /^rv_[0-9a-f]{8}$/.test(allowed) && allowed === reviewerId;
}

/** Called before forwarding non-API requests to the static asset binding. */
export function blockedAssetPath(pathname: string): boolean {
  try {
    const segments: string[] = [];
    for (const segment of decodeURIComponent(pathname).replace(/\\/g, "/").split("/")) {
      if (segment === "..") segments.pop();
      else if (segment && segment !== ".") segments.push(segment);
    }
    const [root, batch] = segments;
    const namespace = root?.toLowerCase();
    // Do not let the asset binding resolve aliases of our API namespace.
    return namespace === "api" || (namespace === "media" && !!batch && restrictedStaticDirectory(batch));
  } catch {
    return true;
  }
}

export function referenceImage(image: StoredImage | undefined, route: string): StoredImage | undefined {
  return image?.ref.source === "r2" && PRIVATE_IMAGE_KEY.test(image.ref.key)
    ? { ...image, ref: { source: "url", url: route } }
    : undefined;
}

/** Caller checks the reviewer, scope and current gate before accessing the bucket. No user input is an object key. */
export async function privateReferenceImage(env: Env, batch: string, image: StoredImage | undefined): Promise<Response> {
  if (image?.ref.source !== "r2" || !PRIVATE_IMAGE_KEY.test(image.ref.key)) throw new HttpError(404, "not_found");
  const object = await env.RESTRICTED_REFERENCE_MEDIA?.get(`${batch}/${image.ref.key}`);
  if (!object) throw new HttpError(404, "not_found");
  const type = image.ref.key.endsWith(".png") ? "png" : image.ref.key.endsWith(".webp") ? "webp" : "jpeg";
  return new Response(object.body, { headers: {
    "content-type": `image/${type}`,
    "cache-control": "private, no-store",
    "cdn-cache-control": "no-store",
    "cloudflare-cdn-cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  } });
}
