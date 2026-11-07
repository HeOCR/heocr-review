/**
 * Cut one crop per proposal from its page image and a reduced full page per item, as static assets under
 * public/media/<batch>/<item>/. File names carry a content hash, so they can be cached forever.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import sharp from "sharp";
import type { Box } from "../../src/shared/media";
import type { StoredImage } from "../../src/tasks/types";

const EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const SAFE = /[^A-Za-z0-9._-]/g;
const PAGE_WIDTH = 1000;
const MAX_CROP_WIDTH = 1400;

export function safeSegment(text: string): string {
  return text.replace(SAFE, "_").slice(0, 120);
}

export function findImage(dir: string, stem: string): string | null {
  for (const ext of EXTENSIONS) {
    const p = join(dir, stem + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The crop rectangle (pixels) around a box: the region, a line or so above and below, and some width. */
export function cropRect(box: Box, w: number, h: number): { left: number; top: number; width: number; height: number } {
  const [x0, y0, x1, y1] = [box[0] * w, box[1] * h, box[2] * w, box[3] * h];
  const bw = x1 - x0;
  const bh = y1 - y0;
  const cw = Math.min(w, Math.max(bw + 2 * Math.max(0.04 * w, 0.5 * bw), 0.32 * w));
  const ch = Math.min(h, Math.max(bh + 2 * Math.max(0.02 * h, 1.2 * bh), 0.07 * h));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const left = Math.round(Math.min(Math.max(0, cx - cw / 2), w - cw));
  const top = Math.round(Math.min(Math.max(0, cy - ch / 2), h - ch));
  return { left, top, width: Math.round(cw), height: Math.round(ch) };
}

function write(outRoot: string, rel: string, data: Buffer): string {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 10);
  const relHashed = rel.replace(/\.jpg$/, `-${hash}.jpg`);
  const abs = join(outRoot, relHashed);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, data);
  return relHashed;
}

export interface PageMedia {
  page: StoredImage;
  crops: Map<string, StoredImage>;
}

/** `publicDir` is the static assets root (public/); paths are stored relative to it (media/...). */
export async function cutPage(
  publicDir: string,
  batchId: string,
  itemStem: string,
  imagePath: string,
  proposals: { externalId: string; box: Box | null }[],
): Promise<PageMedia> {
  const src = sharp(imagePath, { failOn: "error" });
  const meta = await src.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error(`cannot read ${imagePath}`);
  const base = join("media", safeSegment(batchId), safeSegment(itemStem));
  const pageBuf = await sharp(imagePath).resize({ width: Math.min(PAGE_WIDTH, w) }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
  const pageW = Math.min(PAGE_WIDTH, w);
  const pageH = Math.round((h * pageW) / w);
  const page: StoredImage = {
    ref: { source: "static", path: write(publicDir, join(base, "page.jpg"), pageBuf) },
    width: pageW,
    height: pageH,
    box: null,
  };
  const crops = new Map<string, StoredImage>();
  for (const p of proposals) {
    if (!p.box) continue;
    const r = cropRect(p.box, w, h);
    const scale = Math.min(1, MAX_CROP_WIDTH / r.width);
    const buf = await sharp(imagePath)
      .extract(r)
      .resize({ width: Math.round(r.width * scale) })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    const rel = (v: number) => Math.round(v * 10000) / 10000;
    const box: Box = [
      rel((p.box[0] * w - r.left) / r.width),
      rel((p.box[1] * h - r.top) / r.height),
      rel((p.box[2] * w - r.left) / r.width),
      rel((p.box[3] * h - r.top) / r.height),
    ];
    crops.set(p.externalId, {
      ref: { source: "static", path: write(publicDir, join(base, `${safeSegment(p.externalId)}.jpg`), buf) },
      width: Math.round(r.width * scale),
      height: Math.round(r.height * scale),
      box,
    });
  }
  return { page, crops };
}

/** One entry of hocrgen's reference_audit_crops.v1 (crops.json in `hocrgen.tools.reference_audit --export-dir`). */
export interface BundleCrop {
  proposal_id: string;
  item_id: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
  source_image_size: [number, number];
  crop_box_px: [number, number, number, number];
  region_box_normalized: Box;
}

export interface CropBundle {
  schema_version: "reference_audit_crops.v1";
  audit_id: string;
  proposals_file: string;
  proposals_sha256: string;
  crops: BundleCrop[];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Check a hocrgen crop bundle against its proposals file and its own checksums. */
export function bundleProblems(dir: string, bundle: CropBundle, auditId: string): string[] {
  const problems: string[] = [];
  if (bundle.schema_version !== "reference_audit_crops.v1") problems.push("crops.json must be reference_audit_crops.v1");
  if (bundle.audit_id !== auditId) problems.push("crops.json audit_id does not match the proposals");
  if (sha256File(join(dir, bundle.proposals_file)) !== bundle.proposals_sha256) problems.push("proposals.json does not match crops.json");
  for (const c of bundle.crops) {
    if (!/^crops\/[A-Za-z0-9._-]+\.jpg$/.test(c.path)) problems.push(`${c.proposal_id}: unexpected crop path`);
    else if (!existsSync(join(dir, c.path))) problems.push(`${c.proposal_id}: crop missing`);
    else if (sha256File(join(dir, c.path)) !== c.sha256) problems.push(`${c.proposal_id}: crop checksum differs`);
  }
  return problems;
}

/** The region in the crop's own coordinates, from the crop box and the source image size. */
export function bundleCropBox(c: BundleCrop): Box {
  const [sw, sh] = c.source_image_size;
  const [cx0, cy0, cx1, cy1] = c.crop_box_px;
  const r = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  const [x0, y0, x1, y1] = c.region_box_normalized;
  return [r((x0 * sw - cx0) / (cx1 - cx0)), r((y0 * sh - cy0) / (cy1 - cy0)), r((x1 * sw - cx0) / (cx1 - cx0)), r((y1 * sh - cy0) / (cy1 - cy0))];
}

/** Copy a bundle crop into public/media/ under a content-hashed name. */
export function placeBundleCrop(publicDir: string, batchId: string, itemStem: string, dir: string, c: BundleCrop): StoredImage {
  const rel = join("media", safeSegment(batchId), safeSegment(itemStem), `${safeSegment(c.proposal_id)}.jpg`);
  return {
    ref: { source: "static", path: write(publicDir, rel, readFileSync(join(dir, c.path))) },
    width: c.width,
    height: c.height,
    box: bundleCropBox(c),
    outlined: true,
  };
}

/** Only the reduced full page (when crops come from a bundle). */
export async function pageOnly(publicDir: string, batchId: string, itemStem: string, imagePath: string): Promise<StoredImage> {
  return (await cutPage(publicDir, batchId, itemStem, imagePath, [])).page;
}

/** Line crops (line_verify): one per line, the context band at the scan's own resolution up to this width. */
export const LINE_CROP_MAX_WIDTH = 1800;

/**
 * The crop rectangle (pixels) for one line: the union of its ink box and its context band, with a little air
 * around it, inside the page.
 */
export function lineCropRect(box: Box, context: Box, w: number, h: number): { left: number; top: number; width: number; height: number } {
  const lineH = (box[3] - box[1]) * h;
  const padX = Math.max(0.01 * w, 0.5 * lineH);
  const padY = 0.25 * lineH;
  const x0 = Math.max(0, Math.floor(Math.min(box[0], context[0]) * w - padX));
  const y0 = Math.max(0, Math.floor(Math.min(box[1], context[1]) * h - padY));
  const x1 = Math.min(w, Math.ceil(Math.max(box[2], context[2]) * w + padX));
  const y1 = Math.min(h, Math.ceil(Math.max(box[3], context[3]) * h + padY));
  return { left: x0, top: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** Problems with the page images a bundle ships (path inside the bundle, present, checksum). */
export function bundleImageProblems(dir: string, images: { path: string; sha256: string }[]): string[] {
  const problems: string[] = [];
  const root = realpathSync(dir);
  for (const img of images) {
    const abs = join(dir, img.path);
    if (!existsSync(abs)) problems.push(`${img.path}: missing`);
    else if (!realpathSync(abs).startsWith(root + sep)) problems.push(`${img.path}: outside the bundle`);
    else if (sha256File(abs) !== img.sha256) problems.push(`${img.path}: checksum differs from items.json`);
  }
  return problems;
}

/**
 * Cut one crop per line (its context band, with the line's ink box in crop coordinates) and a reduced full page,
 * as content-hashed static assets under public/media/<batch>/<page>/. Boxes are fractions of the page; the image
 * must have the aspect ratio items.json declares (any size: a uniformly scaled raster is fine).
 */
export async function cutLines(
  publicDir: string,
  batchId: string,
  pageStem: string,
  imagePath: string,
  declared: { width: number; height: number },
  lines: { externalId: string; box: Box; contextBox: Box }[],
): Promise<PageMedia> {
  const input = readFileSync(imagePath);
  const meta = await sharp(input, { failOn: "error" }).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error(`cannot read ${imagePath}`);
  if (Math.abs(w / h - declared.width / declared.height) > 0.01 * (declared.width / declared.height)) {
    throw new Error(`${imagePath} is ${w}x${h}, but items.json says ${declared.width}x${declared.height}`);
  }
  const base = join("media", safeSegment(batchId), safeSegment(pageStem));
  const pageW = Math.min(PAGE_WIDTH, w);
  const pageBuf = await sharp(input).resize({ width: pageW }).jpeg({ quality: 72, mozjpeg: true }).toBuffer();
  const page: StoredImage = {
    ref: { source: "static", path: write(publicDir, join(base, "page.jpg"), pageBuf) },
    width: pageW,
    height: Math.round((h * pageW) / w),
    box: null,
  };
  const crops = new Map<string, StoredImage>();
  const rel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  for (const line of lines) {
    const r = lineCropRect(line.box, line.contextBox, w, h);
    const outW = Math.min(r.width, LINE_CROP_MAX_WIDTH);
    const buf = await sharp(input).extract(r).resize({ width: outW }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    crops.set(line.externalId, {
      ref: { source: "static", path: write(publicDir, join(base, `${safeSegment(line.externalId)}.jpg`), buf) },
      width: outW,
      height: Math.max(1, Math.round((r.height * outW) / r.width)),
      box: [
        rel((line.box[0] * w - r.left) / r.width),
        rel((line.box[1] * h - r.top) / r.height),
        rel((line.box[2] * w - r.left) / r.width),
        rel((line.box[3] * h - r.top) / r.height),
      ],
    });
  }
  return { page, crops };
}
