export const MANIFEST_SCHEMA = "synth_realism_manifest.v1";
export const CLEARANCE_SCHEMA = "synth_realism_clearance.v1";
export const SESSION_SIZE = 50;

export interface ImageFile { path: string; sha256: string }
export interface RealismItem {
  item_id: string;
  synthetic_image: ImageFile;
  synthetic_line_crop: ImageFile;
  real_ref_image: ImageFile;
  real_ref_line_crop: ImageFile;
  real_ref_id: string;
  synthetic_ref_id?: string;
  generator_id: string;
  generator_version: string;
  params_hash: string;
  control_kind: "standard" | "real_real" | "attention";
}
export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  batch_id: string;
  items: RealismItem[];
}
interface ClearedPair {
  id: string;
  split: "train" | "dev";
  source: string;
  license: string;
  page_sha256: string;
  line_sha256: string;
}
export interface Clearance {
  schema: typeof CLEARANCE_SCHEMA;
  references: ClearedPair[];
}

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const token = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(x);
export const isSha = (x: unknown) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
export const IMAGE_FIELDS = ["synthetic_image", "synthetic_line_crop", "real_ref_image", "real_ref_line_crop"] as const;
const validImage = (v: unknown) => object(v) && isSha(v.sha256) && typeof v.path === "string"
  && /^images\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp)$/i.test(v.path);
export const restrictedPath = (path: string) => /(?:^|\/)(?:eval_refs|heocr-restricted-eval|restricted[_-]eval|test|held[_-]?out|preregistration)(?:\/|$)|(?:^|\/)runs\/[^/]*test|(?:^|\/)scans\/(?:ps_v1|nq1)(?:\/|$)/i
  .test(path.replaceAll("\\", "/"));

export function parseManifest(raw: unknown): Manifest {
  if (!object(raw) || raw.schema !== MANIFEST_SCHEMA || !token(raw.batch_id) || !Array.isArray(raw.items) ||
    raw.items.length < 1 || raw.items.length > SESSION_SIZE) throw new Error("invalid realism manifest header or session size");
  const ids = new Set<unknown>();
  const pairs = new Set<string>();
  let realReal = 0;
  let attention = 0;
  for (const item of raw.items as unknown[]) {
    if (!object(item) || !token(item.item_id) || ids.has(item.item_id) || !token(item.real_ref_id) ||
      !token(item.generator_id) || !token(item.generator_version) || !isSha(item.params_hash) ||
      !IMAGE_FIELDS.every((field) => validImage(item[field]))) throw new Error("invalid or duplicate realism item");
    if (item.control_kind === "real_real") {
      realReal++;
      if (!token(item.synthetic_ref_id) || item.synthetic_ref_id === item.real_ref_id) throw new Error("real-real control requires a second cleared reference");
    } else {
      if (item.control_kind === "attention") attention++;
      else if (item.control_kind !== "standard") throw new Error("invalid control kind");
      if (item.synthetic_ref_id !== undefined) throw new Error("only a real-real control can have synthetic_ref_id");
    }
    const row = item as unknown as RealismItem;
    if (row.synthetic_image.sha256 === row.real_ref_image.sha256 || row.synthetic_line_crop.sha256 === row.real_ref_line_crop.sha256) {
      throw new Error("the two sides must use distinct pages and line crops");
    }
    const pair = [row.synthetic_image.sha256, row.real_ref_image.sha256].sort().join(":");
    if (pairs.has(pair)) throw new Error("a page pair occurs twice");
    pairs.add(pair);
    ids.add(item.item_id);
  }
  if (realReal !== Math.round(raw.items.length * 0.10) || attention !== Math.round(raw.items.length * 0.05)) {
    throw new Error("control counts must be 10% real-real and 5% attention, rounded to the nearest item");
  }
  return raw as unknown as Manifest;
}

export function verifyClearance(raw: unknown, manifest: Manifest): void {
  if (!object(raw) || raw.schema !== CLEARANCE_SCHEMA || !Array.isArray(raw.references)) throw new Error("invalid eval clearance");
  const refs = new Map<string, ClearedPair>();
  for (const ref of raw.references as unknown[]) {
    if (!object(ref) || !token(ref.id) || refs.has(String(ref.id)) || (ref.split !== "train" && ref.split !== "dev") ||
      typeof ref.source !== "string" || !ref.source.trim() || restrictedPath(ref.source) ||
      typeof ref.license !== "string" || !/^(?:public domain|CC0(?:-1\.0)?|CC BY(?:-SA)? (?:3\.0|4\.0))$/i.test(ref.license) ||
      !isSha(ref.page_sha256) || !isSha(ref.line_sha256)) throw new Error("invalid or non-train/dev eval clearance record");
    refs.set(String(ref.id), ref as unknown as ClearedPair);
  }
  const realAssets = new Set([...refs.values()].flatMap((ref) => [ref.page_sha256, ref.line_sha256]));
  function match(id: string, page: ImageFile, line: ImageFile): void {
    const ref = refs.get(id);
    if (ref?.page_sha256 !== page.sha256 || ref.line_sha256 !== line.sha256) throw new Error("real reference page and crop must match eval clearance");
  }
  for (const item of manifest.items) {
    match(item.real_ref_id, item.real_ref_image, item.real_ref_line_crop);
    if (item.synthetic_ref_id) match(item.synthetic_ref_id, item.synthetic_image, item.synthetic_line_crop);
    else if (realAssets.has(item.synthetic_image.sha256) || realAssets.has(item.synthetic_line_crop.sha256)) {
      throw new Error("a standard or attention synthetic side contains a cleared real asset");
    }
  }
}
