import { requirePhoto, sanitizeExif, type PhotoMetadata } from "./exif";

type Span = { start: number; end: number };
type Box = Span & { type: string; payload: number };
type Item = { id: number; type: string };
const pictures = new Set(["hvc1", "hev1", "grid", "iden", "iovl", "tmap"]);
const stillBrands = new Set(["heic", "heix", "heim", "heis"]);
const movieBrands = new Set(["hevc", "hevx", "hevm", "hevs", "msf1"]);
const properties = new Set([
  "hvcC", "ispe", "pixi", "irot", "imir", "clap", "pasp", "auxC",
  "colr", "clli", "mdcv", "amve", "lsel", "a1lx", "a1op", "oinf",
]);
const ascii = (data: Uint8Array, start: number, size: number) =>
  String.fromCharCode(...data.subarray(start, start+size));
const encoder = new TextEncoder();

/**
 * In-place container rewrite on a private copy. Pixel item extents and image
 * properties stay at their original offsets. Strip unreferenced data and neutralize
 * metadata boxes without shifting any offsets. Unsupported layouts fail before R2.
 */
export function sanitizeHeic(input: Uint8Array, meta: PhotoMetadata): Uint8Array<ArrayBuffer> {
  const data = input.slice();
  const view = new DataView(data.buffer);
  function boxes(start: number, end: number) {
    const result: Box[] = [];
    while (start < end) {
      requirePhoto(result.length < 4096 && start+8 <= end);
      const type = ascii(data,start+4,4);
      let size = view.getUint32(start), header = 8;
      if (size === 1) {
        requirePhoto(start+16 <= end && view.getUint32(start+8) === 0);
        size = view.getUint32(start+12);
        header = 16;
      } else if (size === 0) {
        requirePhoto(type === "mdat");
        size = end-start;
      }
      requirePhoto(size >= header && start+size <= end);
      result.push({type,start,payload:start+header,end:start+size});
      start += size;
    }
    return result;
  }
  function one(list: Box[], type: string) {
    const found = list.filter(box => box.type === type);
    requirePhoto(found.length === 1);
    return found[0]!;
  }
  function drop(box: Box, tag = box.type) {
    data.set(encoder.encode("free"),box.start+4);
    data.fill(0,box.payload,box.end);
    if (tag !== "free") meta.removed.add("HEIC."+tag);
  }
  function cursor(box: Box, skip = 0) {
    let index = box.payload+skip;
    return {
      get index() { return index; },
      read(width: number) {
        requirePhoto(width <= 8 && index+width <= box.end);
        let value = 0;
        for (let i=0;i<width;i++) value = value*256+data[index++]!;
        requirePhoto(Number.isSafeInteger(value));
        return value;
      },
    };
  }

  const top = boxes(0,data.length);
  const ftyp = one(top,"ftyp");
  requirePhoto(top[0] === ftyp && ftyp.end-ftyp.payload >= 8 && ftyp.end-ftyp.payload <= 512 &&
    (ftyp.end-ftyp.payload)%4 === 0);
  const brands = [ascii(data,ftyp.payload,4)];
  for(let i=ftyp.payload+8;i<ftyp.end;i+=4) brands.push(ascii(data,i,4));
  requirePhoto(brands.some(b => stillBrands.has(b)) && !brands.some(b => movieBrands.has(b)));
  const root = one(top,"meta");
  requirePhoto(root.payload+4 <= root.end && view.getUint32(root.payload) === 0);
  const children = boxes(root.payload+4,root.end);
  const mdats = top.filter(box => box.type === "mdat");
  const idats = children.filter(box => box.type === "idat");
  requirePhoto(idats.length <= 1);
  const itemInfo = one(children,"iinf"), itemLoc = one(children,"iloc");
  const handler = one(children,"hdlr");
  requirePhoto(handler.payload+24 <= handler.end && ascii(data,handler.payload+8,4) === "pict");
  data.fill(0,handler.payload+12,handler.end);
  const primary = one(children,"pitm");
  const primaryCursor = cursor(primary);
  const primaryVersion = primaryCursor.read(1);
  requirePhoto(primaryVersion <= 1 && primaryCursor.read(3) === 0);
  const primaryId = primaryCursor.read(primaryVersion ? 4 : 2);
  requirePhoto(primaryCursor.index === primary.end);

  const infos = cursor(itemInfo);
  const infoVersion = infos.read(1);
  requirePhoto(infoVersion <= 1 && infos.read(3) === 0);
  const count = infos.read(infoVersion ? 4 : 2);
  const items = new Map<number,Item>();
  const entries = boxes(infos.index,itemInfo.end);
  requirePhoto(entries.length === count && count <= 1024);
  for (const entry of entries) {
    requirePhoto(entry.type === "infe");
    const c = cursor(entry);
    const version = c.read(1);
    requirePhoto(version === 2 || version === 3);
    c.read(3); // FullBox flags, including the hidden item bit.
    const id = c.read(version === 2 ? 2 : 4);
    requirePhoto(c.read(2) === 0 && c.index+4 < entry.end && !items.has(id));
    const type = ascii(data,c.index,4);
    c.read(4);
    requirePhoto(pictures.has(type) || type === "Exif" || type === "mime");
    if (type === "mime") {
      // Replace metadata descriptors too: item names and arbitrary MIME strings are not needed.
      const replacement = encoder.encode("\0application/rdf+xml\0");
      requirePhoto(c.index+replacement.length <= entry.end);
      data.fill(0,c.index,entry.end);
      data.set(replacement,c.index);
    } else {
      data.fill(0,c.index,entry.end);
    }
    items.set(id,{id,type});
  }
  requirePhoto(pictures.has(items.get(primaryId)?.type ?? ""));

  const loc = cursor(itemLoc);
  const version = loc.read(1);
  requirePhoto(version <= 2 && loc.read(3) === 0);
  const widths = loc.read(2);
  const offsetWidth = widths>>12, lengthWidth = (widths>>8)&15;
  const baseWidth = (widths>>4)&15, indexWidth = version ? widths&15 : 0;
  requirePhoto(lengthWidth > 0 && [offsetWidth,lengthWidth,baseWidth,indexWidth].every(width => width <= 8));
  const itemCount = loc.read(version < 2 ? 2 : 4);
  requirePhoto(itemCount <= items.size);
  const ranges: (Span & Item)[] = [];
  const located = new Set<number>();
  for (let i=0;i<itemCount;i++) {
    const id = loc.read(version < 2 ? 2 : 4);
    const item = items.get(id);
    const method = version ? loc.read(2) : 0;
    requirePhoto(item && !located.has(id) && (method === 0 || method === 1) && loc.read(2) === 0);
    located.add(id);
    const base = loc.read(baseWidth);
    const extents = loc.read(2);
    requirePhoto(extents >= 1 && extents <= 128 && ranges.length+extents <= 4096 &&
      (item.type !== "Exif" || extents === 1));
    for (let j=0;j<extents;j++) {
      requirePhoto(loc.read(indexWidth) === 0);
      const rel = loc.read(offsetWidth), length = loc.read(lengthWidth);
      const start = base+rel+(method === 1 ? idats[0]?.payload ?? NaN : 0);
      const end = start+length;
      const containers = method === 1 ? idats : mdats;
      requirePhoto(length > 0 && Number.isSafeInteger(end) && containers.some(box => start >= box.payload && end <= box.end));
      ranges.push({start,end,...item});
    }
  }
  requirePhoto(loc.index === itemLoc.end && located.has(primaryId) && located.size === items.size);
  ranges.sort((a,b) => a.start-b.start || a.end-b.end);
  // Overlaps could let opaque payload survive via an image item or let metadata edits touch pixels.
  for(let i=1;i<ranges.length;i++) requirePhoto(ranges[i-1]!.end <= ranges[i]!.start);
  for (const range of ranges) {
    const {start,end,type} = range;
    if (type === "Exif") {
      requirePhoto(start+4 <= end);
      const tiff = start+4+view.getUint32(start);
      requirePhoto(tiff+8 <= end);
      const safe = sanitizeExif(input.subarray(tiff,end),meta);
      requirePhoto(start+4+safe.length <= end);
      data.fill(0,start,end);
      data.set(safe,start+4); // TIFF data begins immediately after the zero offset.
    } else if (type === "mime") {
      data.fill(32,start,end);
      const empty = encoder.encode("<x/>");
      requirePhoto(end-start >= empty.length);
      data.set(empty,start);
      meta.removed.add("HEIC.XMP/MIME");
    }
  }
  for (const container of [...mdats,...idats]) {
    let end = container.payload;
    for (const range of ranges) {
      if (range.start < container.payload || range.end > container.end) continue;
      data.fill(0,end,range.start);
      end = range.end;
    }
    data.fill(0,end,container.end);
  }

  const keepMeta = new Set(["hdlr","pitm","iinf","iloc","iref","iprp","idat"]);
  for (const box of children) if (!keepMeta.has(box.type)) drop(box);
  for (const box of top) if (!["ftyp","meta","mdat"].includes(box.type)) {
    requirePhoto(!["moov","moof","mfra"].includes(box.type));
    drop(box);
  }
  const iprp = one(children,"iprp");
  const iprpChildren = boxes(iprp.payload,iprp.end);
  const ipco = one(iprpChildren,"ipco");
  for (const box of iprpChildren) if (!["ipco","ipma"].includes(box.type)) drop(box);
  for (const prop of boxes(ipco.payload,ipco.end)) {
    // Preserve property numbering. A free UUID/property can't retain personal metadata.
    if (!properties.has(prop.type)) drop(prop, "property."+prop.type);
  }
  return data;
}
