import { PRIVATE_IMAGE_KEY } from "../shared/media";
import { restrictedStaticDirectory } from "../tasks/restricted_reference";
import type { BatchRecord, StoredImage } from "../tasks/types";
import type { Env } from "./env";
import { HttpError } from "./http";

export const RESTRICTED_MEDIA_PATH = "/api/restricted-media/v1";

export function canReadReference(env: Env, url: URL, reviewerId: string, batch: BatchRecord): boolean {
  if (!batch.restrictedReference) {
    // Existing legacy data stays in D1. On deployment it cannot be served until its private roster is installed.
    return env.ENVIRONMENT === "development" || !restrictedStaticDirectory(batch.id);
  }
  if (!["line_verify", "page_review"].includes(batch.taskType)) return false;
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
