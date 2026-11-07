/**
 * Where an image comes from. Today every crop and page image is a Worker static asset under /media/; the union
 * leaves room for another source (an object store, an IIIF server) without touching the review UI.
 */
export type ImageRef = { source: "static"; path: string } | { source: "url"; url: string };

/** A box in fractions of an image: [x0, y0, x1, y1], origin top-left. */
export type Box = [number, number, number, number];

export interface ImageView {
  url: string;
  width: number;
  height: number;
  /** The region of interest in this image, if any. */
  box: Box | null;
  /** The region is already outlined in the image itself. */
  outlined?: boolean;
}

const STATIC_PATH = /^media\/[A-Za-z0-9._\-/]+\.(?:jpg|jpeg|png|webp)$/;

export function isImageRef(value: unknown): value is ImageRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  if (ref.source === "static") return typeof ref.path === "string" && STATIC_PATH.test(ref.path) && !ref.path.includes("..");
  if (ref.source === "url") return typeof ref.url === "string" && /^https:\/\//.test(ref.url);
  return false;
}

export function imageUrl(ref: ImageRef): string {
  return ref.source === "static" ? `/${ref.path}` : ref.url;
}
