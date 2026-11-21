import { imageFrame } from "./handwriting/image";
import type { captureFile } from "../shared/registered-captures";

type Extension = NonNullable<ReturnType<typeof captureFile>>["ext"];

// HEIF originals are retained for eval's offline decoder. Only still HEVC picture brands are admitted.
const stillHevc = new Set(["heic", "heix", "heim", "heis"]);
const sequence = new Set(["hevc", "hevx", "hevm", "hevs", "msf1"]);
function isHeic(data: Uint8Array) {
  if (data.length < 24) return false;
  const tag = (i: number) => String.fromCharCode(...data.subarray(i, i + 4));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = view.getUint32(0);
  if (tag(4) !== "ftyp" || end < 16 || end > 4096 || end > data.length || end % 4 !== 0) return false;
  const brands = [tag(8)];
  for (let offset = 16; offset < end; offset += 4) brands.push(tag(offset));
  if (!brands.some(brand => stillHevc.has(brand)) || brands.some(brand => sequence.has(brand))) return false;
  // Reject a truncated or brand-only container. Decode and screen with eval's offline tools before freeze.
  let metadata = false;
  let payload = false;
  for (let i = end; i < data.length;) {
    if (i + 8 > data.length) return false;
    const size = view.getUint32(i);
    if (size < 8 || i + size > data.length) return false;
    metadata ||= tag(i+4) === "meta" && size > 12;
    payload ||= tag(i+4) === "mdat" && size > 8;
    i += size;
  }
  return metadata && payload;
}

export function captureImageType(data: Uint8Array, ext: Extension) {
  if (ext === "heic" || ext === "heif") return isHeic(data) ? "image/heic" : null;
  const type = ext === "png" ? "image/png" : "image/jpeg";
  return imageFrame(data)?.mime === type ? type : null;
}
