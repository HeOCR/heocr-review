/** Build a new TIFF from the photographic fields we can safely carry forward. Never copy opaque offsets, maker notes or thumbnails. */
const ifd0Tags = {
  0x010f: ["Make", 2], 0x0110: ["Model", 2], 0x0112: ["Orientation", 3],
  0x011a: ["XResolution", 5], 0x011b: ["YResolution", 5], 0x0128: ["ResolutionUnit", 3],
  0x0132: ["ModifyDate", 2], 0x0213: ["YCbCrPositioning", 3],
} as const;
const photoTags = {
  0x829a: ["ExposureTime", 5], 0x829d: ["FNumber", 5], 0x8822: ["ExposureProgram", 3],
  0x8827: ["ISO", 3], 0x8830: ["SensitivityType", 3], 0x8832: ["RecommendedExposureIndex", 4],
  0x9000: ["ExifVersion", 7], 0x9003: ["DateTimeOriginal", 2], 0x9004: ["CreateDate", 2],
  0x9010: ["OffsetTime", 2], 0x9011: ["OffsetTimeOriginal", 2], 0x9012: ["OffsetTimeDigitized", 2],
  0x9201: ["ShutterSpeedValue", 10], 0x9202: ["ApertureValue", 5], 0x9203: ["BrightnessValue", 10],
  0x9204: ["ExposureCompensation", 10], 0x9205: ["MaxApertureValue", 5], 0x9206: ["SubjectDistance", 5],
  0x9207: ["MeteringMode", 3], 0x9208: ["LightSource", 3], 0x9209: ["Flash", 3], 0x920a: ["FocalLength", 5],
  0x9214: ["SubjectArea", 3], 0x9290: ["SubSecTime", 2], 0x9291: ["SubSecTimeOriginal", 2],
  0x9292: ["SubSecTimeDigitized", 2], 0xa000: ["FlashpixVersion", 7], 0xa001: ["ColorSpace", 3],
  0xa002: ["ExifImageWidth", 4], 0xa003: ["ExifImageHeight", 4], 0xa217: ["SensingMethod", 3],
  0xa402: ["ExposureMode", 3], 0xa403: ["WhiteBalance", 3], 0xa404: ["DigitalZoomRatio", 5],
  0xa405: ["FocalLengthIn35mmFormat", 3], 0xa406: ["SceneCaptureType", 3],
  0xa408: ["Contrast", 3], 0xa409: ["Saturation", 3], 0xa40a: ["Sharpness", 3],
  0xa432: ["LensInfo", 5], 0xa433: ["LensMake", 2], 0xa434: ["LensModel", 2],
} as const;
const excluded: Record<number, string> = {
  0x010e: "ImageDescription", 0x013b: "Artist", 0x02bc: "XMP", 0x83bb: "IPTC",
  0x8825: "GPSIFD", 0x927c: "MakerNote", 0x9286: "UserComment", 0xa005: "InteropIFD",
  0xa420: "ImageUniqueID", 0xa430: "OwnerName", 0xa431: "SerialNumber", 0xa435: "LensSerialNumber",
};
const gpsTags = [
  "GPSVersionID", "GPSLatitudeRef", "GPSLatitude", "GPSLongitudeRef", "GPSLongitude", "GPSAltitudeRef", "GPSAltitude",
  "GPSTimeStamp", "GPSSatellites", "GPSStatus", "GPSMeasureMode", "GPSDOP", "GPSSpeedRef", "GPSSpeed",
  "GPSTrackRef", "GPSTrack", "GPSImgDirectionRef", "GPSImgDirection", "GPSMapDatum", "GPSDestLatitudeRef",
  "GPSDestLatitude", "GPSDestLongitudeRef", "GPSDestLongitude", "GPSDestBearingRef", "GPSDestBearing",
  "GPSDestDistanceRef", "GPSDestDistance", "GPSProcessingMethod", "GPSAreaInformation", "GPSDateStamp",
  "GPSDifferential", "GPSHPositioningError",
];
const sizes: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };
type Entry = { tag: number; type: number; count: number; data: Uint8Array };
type FieldMap = Readonly<Record<number, readonly [string, number]>>;
const decoder = new TextDecoder();

export class UnsupportedPhoto extends Error {
  constructor() { super("unsupported_or_unsafe_photo"); }
}
export function requirePhoto(condition: unknown): asserts condition {
  if (!condition) throw new UnsupportedPhoto();
}
export type PhotoMetadata = { make: string | null; model: string | null; removed: Set<string> };

export function sanitizeExif(data: Uint8Array, meta: PhotoMetadata): Uint8Array {
  const raw = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const little = data[0] === 73 && data[1] === 73;
  requirePhoto(data.length >= 8 && (little || (data[0] === 77 && data[1] === 77)) && raw.getUint16(2,little) === 42);
  const u16 = (offset: number) => raw.getUint16(offset,little);
  const u32 = (offset: number) => raw.getUint32(offset,little);

  function directory(offset: number) {
    requirePhoto(offset >= 8 && offset + 6 <= data.length);
    const count = u16(offset);
    const end = offset + 2 + count * 12;
    requirePhoto(count <= 512 && end + 4 <= data.length);
    return { offsets: Array.from({length:count}, (_,i) => offset+2+i*12), next: u32(end) };
  }

  let exifOffset = 0;
  function fields(offset: number, allowed: FieldMap, root: boolean) {
    const kept: Entry[] = [];
    const { offsets, next } = directory(offset);
    if (next) meta.removed.add(root ? "Exif.ThumbnailIFD" : "Exif.LinkedIFD");
    const seen = new Set<number>();
    for (const i of offsets) {
      const tag = u16(i), type = u16(i+2), count = u32(i+4);
      requirePhoto(!seen.has(tag));
      seen.add(tag);
      if (root && tag === 0x8769) {
        requirePhoto(type === 4 && count === 1);
        exifOffset = u32(i+8);
        continue;
      }
      if (tag === 0x8825) {
        requirePhoto(type === 4 && count === 1);
        for (const gps of directory(u32(i+8)).offsets) {
          const gpsTag = u16(gps);
          meta.removed.add("Exif."+(gpsTags[gpsTag] ?? `GPS.0x${gpsTag.toString(16)}`));
        }
      }
      const def = allowed[tag];
      if (!def || (type !== def[1] && !((tag === 0xa002 || tag === 0xa003) && type === 3))) {
        meta.removed.add("Exif."+(def?.[0] ?? excluded[tag] ?? `0x${tag.toString(16).padStart(4,"0")}`));
        continue;
      }
      const length = count * sizes[type]!;
      // Restrict arrays to the few numeric photographic tags that use them.
      const limit = type === 2 ? 129 : (tag === 0xa432 || tag === 0x9214 || type === 7) ? 4 * sizes[type]! : sizes[type]!;
      requirePhoto(length > 0 && length <= limit);
      const start = length <= 4 ? i+8 : u32(i+8);
      requirePhoto(start >= 8 && start+length <= data.length);
      const value = data.subarray(start,start+length);
      if (type === 2) {
        const end = value.indexOf(0);
        const val = decoder.decode(value.subarray(0,end < 0 ? value.length : end));
        if (end !== value.length-1 || !/^[A-Za-z0-9 ()+_.,:/-]+$/.test(val)) {
          meta.removed.add("Exif."+def[0]);
          continue;
        }
        if (tag === 0x010f) meta.make ??= val.trim();
        if (tag === 0x0110) meta.model ??= val.trim();
      }
      kept.push({tag,type,count,data:value});
    }
    return kept;
  }

  const first = fields(u32(4),ifd0Tags,true);
  const photo = exifOffset ? fields(exifOffset,photoTags,false) : [];
  const tableSize = (entries: Entry[]) => 6+entries.length*12;
  const photoStart = 8+tableSize(first)+12;
  if (photo.length) {
    const ptr = new Uint8Array(4);
    new DataView(ptr.buffer).setUint32(0,photoStart,little);
    first.push({tag:0x8769,type:4,count:1,data:ptr});
  }
  let valueOffset = 8+tableSize(first)+(photo.length ? tableSize(photo) : 0);
  const padded = (size: number) => size+(size%2);
  const extra = first.concat(photo).reduce((sum,e) => sum+(e.data.length>4 ? padded(e.data.length) : 0),0);
  const out = new Uint8Array(valueOffset+extra);
  const view = new DataView(out.buffer);
  out.set(data.subarray(0,4));
  const put16 = (i:number,v:number) => view.setUint16(i,v,little);
  const put32 = (i:number,v:number) => view.setUint32(i,v,little);
  put32(4,8);
  function write(offset: number, entries: Entry[]) {
    put16(offset,entries.length);
    entries.sort((a,b) => a.tag-b.tag).forEach((entry,i) => {
      const pos = offset+2+i*12;
      put16(pos,entry.tag); put16(pos+2,entry.type); put32(pos+4,entry.count);
      if (entry.data.length <= 4) out.set(entry.data,pos+8);
      else {
        put32(pos+8,valueOffset);
        out.set(entry.data,valueOffset);
        valueOffset += padded(entry.data.length);
      }
    });
  }
  write(8,first);
  if (photo.length) write(photoStart,photo);
  return out;
}
