type Frame = { width: number; height: number; mime: "image/jpeg" | "image/png" };
export const MAX_ORIGINAL = 12 * 1024 * 1024;
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_PIXELS = new Set(["IHDR", "IDAT", "IEND"]);
const jpegFrame = new Set([0xc0, 0xc1, 0xc2]);

/** Inspect the original byte frame. A derivative is a PNG raster without ancillary or trailing metadata. */
export function imageFrame(data: Uint8Array, derivative = false): Frame | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 45 && PNG.every((byte, i) => data[i] === byte)) {
    let width = 0, height = 0, pixels = false;
    for (let i = 8; i + 12 <= data.length;) {
      const length = view.getUint32(i);
      const tag = String.fromCharCode(...data.subarray(i + 4, i + 8));
      if (i + 12 + length > data.length || (derivative && !PNG_PIXELS.has(tag))) return null;
      if (i === 8) {
        if (tag !== "IHDR" || length !== 13) return null;
        width = view.getUint32(i + 8);
        height = view.getUint32(i + 12);
      } else if (tag === "IHDR") return null;
      if (tag === "IDAT") pixels = true;
      i += 12 + length;
      if (tag === "IEND") return pixels && !length && i === data.length ? frame(width, height, "image/png") : null;
    }
  } else if (!derivative && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) {
    for (let i = 2; i + 4 <= data.length;) {
      if (data[i] !== 0xff) return null;
      const tag = data[i + 1]!;
      if (tag === 0xff) { i++; continue; }
      const length = view.getUint16(i + 2);
      if (length < 2 || i + 2 + length > data.length || tag === 0xda) return null;
      if (jpegFrame.has(tag)) return length >= 8 ? frame(view.getUint16(i + 7), view.getUint16(i + 5), "image/jpeg") : null;
      i += 2 + length;
    }
  }
  return null;
}

function frame(width: number, height: number, mime: Frame["mime"]): Frame | null {
  return width > 0 && height > 0 && width <= 12000 && height <= 12000 && width * height <= 40_000_000
    ? { width, height, mime } : null;
}
