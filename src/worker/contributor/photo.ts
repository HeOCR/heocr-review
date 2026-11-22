import { imageFrame } from "../handwriting/image";

// Preserve the original bytes, but reject common identifying metadata on this
// intake. The private quarantine still requires a human content/privacy pass.
const privateExif = new Set([0x8825, 0x013b, 0x8298, 0x9286, 0xa430, 0xa431, 0xa435]);

function safeExif(bytes: Uint8Array) {
  if (bytes.length < 8) return false;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = v.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  const little = order === 0x4949;
  if (v.getUint16(2, little) !== 42) return false;
  const seen = new Set<number>(), pending = [v.getUint32(4, little)];
  while (pending.length) {
    const start = pending.pop()!;
    if (start === 0 || seen.has(start)) continue;
    if (seen.size >= 16 || start < 8 || start + 2 > bytes.length) return false;
    seen.add(start);
    const count = v.getUint16(start, little);
    const end = start + 2 + count * 12;
    if (end + 4 > bytes.length) return false;
    for (let i = start + 2; i < end; i += 12) {
      const id = v.getUint16(i, little);
      if (privateExif.has(id)) return false;
      if (id === 0x8769 || id === 0xa005) pending.push(v.getUint32(i+8, little));
    }
    pending.push(v.getUint32(end, little));
  }
  return true;
}

export function contributorPhotoType(bytes: Uint8Array) {
  const frame = imageFrame(bytes);
  if (!frame) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (frame.mime === "image/png") {
    for (let i = 8; i + 12 <= bytes.length;) {
      const size = view.getUint32(i);
      const tag = String.fromCharCode(...bytes.subarray(i+4,i+8));
      if (["tEXt","iTXt","zTXt"].includes(tag)) return null;
      if (tag === "eXIf" && !safeExif(bytes.subarray(i+8,i+8+size))) return null;
      i += size + 12;
    }
  } else {
    for (let i = 2; i + 4 <= bytes.length;) {
      if (bytes[i] !== 255) return null;
      const tag = bytes[i+1]!;
      if (tag === 255) { i++; continue; }
      if (tag === 0xda) break;
      const size = view.getUint16(i+2);
      const end = i + 2 + size;
      if (size < 2 || end > bytes.length || tag === 0xed || tag === 0xfe) return null;
      if (tag === 0xe1) {
        const startsExif = String.fromCharCode(...bytes.subarray(i+4,i+10)) === "Exif\0\0";
        if (!startsExif || !safeExif(bytes.subarray(i+10,end))) return null;
      }
      i = end;
    }
  }
  return frame.mime;
}
