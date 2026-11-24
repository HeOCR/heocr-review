import { requirePhoto, sanitizeExif, type PhotoMetadata } from "./exif";
import { sanitizeHeic } from "./heic";

const exif = new Uint8Array([69,120,105,102,0,0]);
const png = new Uint8Array([137,80,78,71,13,10,26,10]);
const soi = new Uint8Array([255,216]);
const encoder = new TextEncoder();
const starts = (data: Uint8Array, prefix: Uint8Array) => prefix.every((byte,i) => data[i] === byte);
const ascii = (data: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...data.subarray(start,start+length));
const append = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n,p) => n+p.length,0));
  let offset=0;
  for (const part of parts) { out.set(part,offset); offset+=part.length; }
  return out;
};
const jpegTables = new Set([0xc4,0xcc,0xdb,0xdd]);
const jpegFrame = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
function stripJpeg(data: Uint8Array, meta: PhotoMetadata) {
  const parts: Uint8Array[] = [soi];
  const v = new DataView(data.buffer,data.byteOffset,data.byteLength);
  let frame = false, scanned = false;
  for (let pos=2;pos<data.length;) {
    requirePhoto(parts.length < 8192 && data[pos] === 255);
    pos++;
    while (data[pos] === 255) pos++;
    const marker = data[pos++]!;
    // Discard fill bytes ahead of each marker.
    const markerStart = pos-2;
    if (marker === 0xd9) {
      requirePhoto(frame && scanned);
      if (pos !== data.length) meta.removed.add("JPEG.TrailingData");
      parts.push(data.subarray(markerStart,pos));
      return append(parts);
    }
    requirePhoto(pos+2 <= data.length && marker >= 0xc0 && !(marker >= 0xd0 && marker <= 0xd8));
    const end = pos+v.getUint16(pos), segment = data.subarray(pos+2,end);
    requirePhoto(end >= pos+2 && end <= data.length);
    if (marker === 0xe1 && starts(segment,exif)) {
      const tiff = sanitizeExif(segment.subarray(exif.length),meta);
      const part = new Uint8Array(4+exif.length+tiff.length);
      requirePhoto(part.length-2 <= 65535);
      part.set([255,0xe1]);
      new DataView(part.buffer).setUint16(2,part.length-2);
      part.set(exif,4);
      part.set(tiff,4+exif.length);
      parts.push(part);
    } else if (marker === 0xda) {
      const channels = segment[0] ?? 0;
      requirePhoto(frame && channels >= 1 && channels <= 4 && segment.length === 4+2*channels);
      let scanEnd = end;
      for (;;) {
        scanEnd = data.indexOf(255,scanEnd);
        requirePhoto(scanEnd >= 0 && scanEnd+1 < data.length);
        const next = data[scanEnd+1]!;
        if (next === 255) { scanEnd++; continue; }
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { scanEnd+=2; continue; }
        break;
      }
      requirePhoto(scanEnd>end);
      parts.push(data.subarray(markerStart,scanEnd));
      scanned = true;
      pos=scanEnd;
      continue;
    } else if (marker === 0xfe || (marker >= 0xe0 && marker <= 0xef)) {
      const jfif = marker === 0xe0 && segment.length === 14 && ascii(segment,0,5) === "JFIF\0" &&
        segment[12] === 0 && segment[13] === 0;
      const adobe = marker === 0xee && segment.length === 12 && ascii(segment,0,5) === "Adobe";
      const icc = marker === 0xe2 && segment.length >= 14 && ascii(segment,0,12) === "ICC_PROFILE\0";
      if (jfif || adobe || icc) parts.push(data.subarray(markerStart,end));
      else if (marker === 0xe1 && ascii(segment,0,19) === "http://ns.adobe.com") meta.removed.add("JPEG.XMP");
      else if (marker === 0xed) meta.removed.add("JPEG.IPTC/APP13");
      else if (marker === 0xfe) meta.removed.add("JPEG.Comment");
      else meta.removed.add("JPEG.APP"+(marker-0xe0));
    } else {
      requirePhoto(jpegFrame.has(marker) || jpegTables.has(marker));
      if (jpegFrame.has(marker)) {
        const channels = segment[5] ?? 0;
        requirePhoto(!frame && channels >= 1 && channels <= 4 && segment.length === 6+3*channels &&
          (segment[1] || segment[2]) && (segment[3] || segment[4]));
        frame = true;
      }
      parts.push(data.subarray(markerStart,end));
    }
    pos=end;
  }
  requirePhoto(false);
}
const pngKeep = new Set([
  "IHDR","PLTE","IDAT","IEND","tRNS","pHYs","gAMA","cHRM","sRGB","iCCP","cICP","mDCv","cLLi","sBIT","bKGD",
]);
const crcTable = new Uint32Array(256);
for (let i=0;i<256;i++) {
  let c=i;
  for(let j=0;j<8;j++) c = c&1 ? (c>>>1)^0xedb88320 : c>>>1;
  crcTable[i]=c;
}
function exifChunk(tiff: Uint8Array) {
  const chunk = new Uint8Array(tiff.length+12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0,tiff.length);
  chunk.set(encoder.encode("eXIf"),4);
  chunk.set(tiff,8);
  let crc=0xffffffff;
  for(const byte of chunk.subarray(4,-4)) crc=crcTable[(crc^byte)&255]!^(crc>>>8);
  view.setUint32(chunk.length-4,crc^0xffffffff);
  return chunk;
}
function stripPng(data: Uint8Array, meta: PhotoMetadata) {
  const parts: Uint8Array[] = [png];
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  let image=false, seenExif=false;
  for(let pos=8;pos<data.length;) {
    requirePhoto(parts.length<8192 && pos+12<=data.length);
    const length=view.getUint32(pos), end=pos+12+length, type=ascii(data,pos+4,4);
    requirePhoto(end<=data.length && /^[A-Za-z]{4}$/.test(type) &&
      (pos !== 8 ? type !== "IHDR" : (type === "IHDR" && length === 13)));
    if (type === "eXIf") {
      requirePhoto(!seenExif);
      seenExif=true;
      parts.push(exifChunk(sanitizeExif(data.subarray(pos+8,end-4),meta)));
    } else if (pngKeep.has(type)) {
      parts.push(data.subarray(pos,end));
    } else {
      // Unknown critical chunks and animations aren't supported by the still-photo intake.
      requirePhoto(type[0] === type[0]?.toLowerCase() && !["acTL","fcTL","fdAT"].includes(type));
      meta.removed.add("PNG."+type);
    }
    image ||= type === "IDAT" && length>0;
    if (type === "IEND") {
      requirePhoto(image && length === 0);
      if(end!==data.length) meta.removed.add("PNG.TrailingData");
      return append(parts);
    }
    pos=end;
  }
  requirePhoto(false);
}

export function sanitizePhoto(data: Uint8Array) {
  const meta: PhotoMetadata = {make:null,model:null,removed:new Set()};
  if (starts(data,soi)) return {bytes:stripJpeg(data,meta),mime:"image/jpeg",meta};
  if (starts(data,png)) return {bytes:stripPng(data,meta),mime:"image/png",meta};
  if (ascii(data,4,4)==="ftyp") return {bytes:sanitizeHeic(data,meta),mime:"image/heic",meta};
  requirePhoto(false);
}
