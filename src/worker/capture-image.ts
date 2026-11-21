import { imageFrame } from "./handwriting/image";
import type { captureFile } from "../shared/registered-captures";

type Extension = NonNullable<ReturnType<typeof captureFile>>["ext"] | "dng";

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
  if (ext === "dng") return isDng(data) ? "image/x-adobe-dng" : null;
  const type = ext === "png" ? "image/png" : "image/jpeg";
  return imageFrame(data)?.mime === type ? type : null;
}

// TIFF-header check only. As with HEIF, full decoding is part of private admission.
function isDng(data: Uint8Array) {
  if (data.length < 26 || data[0] !== data[1] || (data[0] !== 0x49 && data[0] !== 0x4d)) return false;
  const little = data[0] === 0x49;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(2, little) !== 42) return false;
  const ifd = view.getUint32(4, little);
  if (ifd < 8 || ifd + 6 > data.length) return false;
  const entries = view.getUint16(ifd, little);
  if (ifd + 6 + 12 * entries > data.length) return false;
  for (let i = ifd + 2; i < ifd + 2 + entries * 12; i += 12) {
    if (view.getUint16(i, little) === 50706 && view.getUint16(i + 2, little) === 1 &&
      view.getUint32(i + 4, little) === 4 && data[i + 8] === 1) return true;
  }
  return false;
}
