import sharp, { type Metadata } from "sharp";

const exifHeader = Buffer.from("Exif\0\0");
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const gpsTags = /\bGPS(?:Latitude|Longitude|Altitude|Position|DestLatitude|DestLongitude|VersionID|DateStamp|TimeStamp)\b/i;
const appleLocation = Buffer.from("com.apple.quicktime.location.ISO6709");

/** Inspect IFD0 for Model and the GPS directory tag. No coordinate values are read. */
function tiffFields(bytes: Buffer): { model?: string; gps: boolean } | null {
  const tiff = bytes.subarray(0, exifHeader.length).equals(exifHeader) ? bytes.subarray(exifHeader.length) : bytes;
  if (tiff.length < 8) return null;
  const endian = tiff.toString("ascii", 0, 2);
  if (endian !== "II" && endian !== "MM") return null;
  const short = endian === "II" ? tiff.readUInt16LE.bind(tiff) : tiff.readUInt16BE.bind(tiff);
  const long = endian === "II" ? tiff.readUInt32LE.bind(tiff) : tiff.readUInt32BE.bind(tiff);
  if (short(2) !== 42) return null;
  const start = long(4);
  if (start < 8 || start + 2 > tiff.length) return null;
  const end = start + 2 + 12 * short(start);
  if (end + 4 > tiff.length) return null;
  let model: string | undefined;
  let gps = false;
  for (let offset = start + 2; offset < end; offset += 12) {
    const tag = short(offset);
    if (tag === 0x8825) gps = true;
    if (tag !== 0x0110 || short(offset + 2) !== 2) continue;
    const length = long(offset + 4);
    const data = length <= 4 ? offset + 8 : long(offset + 8);
    if (!length || length > 80 || data + length > tiff.length) continue;
    const value = tiff.subarray(data, data + length).toString("utf8").split("\0", 1)[0]!.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,63}$/.test(value) && /[A-Za-z]/.test(value)) model = value;
  }
  return { model, gps };
}

const codecs: Partial<Record<Metadata["format"], string>> = {
  jpeg: "jpeg", png: "deflate", webp: "webp",
};

export function captureMetadata(photo: Buffer, image: Metadata | null) {
  const tiff = image?.format === "tiff" || image?.format === "raw" ? photo : image?.exif;
  const fields = tiff && tiffFields(tiff);
  const xmpGPS = gpsTags.test(image?.xmp?.toString("utf8") ?? "");
  const locationFound = fields?.gps || xmpGPS || photo.includes(appleLocation);
  const gps = locationFound ? "yes" : !image || (tiff && !fields) ? "unknown" : "no";
  const model = fields?.model ?? "unknown";
  const resolution = image?.width && image.height ? `${image.width}x${image.height}` : "unknown";
  const compression = image ? image.compression ?? codecs[image.format] ?? `${image.format}:unknown` : "unknown";
  return { gps, model, resolution, compression } as const;
}

/** Re-encode pixels, keeping just critical PNG chunks. This also drops unexpected ancillary chunks. */
export async function makeCaptureWorkingPng(photo: Buffer) {
  const png = await sharp(photo, { failOn: "error" }).autoOrient().png({ palette: false }).toBuffer();
  if (!png.subarray(0, pngHeader.length).equals(pngHeader)) throw new Error("working copy is not PNG");
  const pixels = [pngHeader];
  for (let i = pngHeader.length; i + 12 <= png.length;) {
    const length = png.readUInt32BE(i);
    const type = png.toString("ascii", i + 4, i + 8);
    const end = i + 12 + length;
    if (end > png.length) break;
    if (type === "IHDR" || type === "IDAT" || type === "IEND") pixels.push(png.subarray(i, end));
    if (type === "IEND" && length === 0 && end === png.length) return Buffer.concat(pixels);
    i = end;
  }
  throw new Error("working copy PNG is incomplete");
}
