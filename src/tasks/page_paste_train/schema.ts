import { PAGE_PASTE_TRAIN } from "../../shared/page_paste_train";

export const MANIFEST_SCHEMA = "page_paste_train_manifest.v1";
export const TRAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_PATH = /^pages\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:jpe?g|png|webp)$/;
const OPEN_RIGHTS = /^https:\/\/creativecommons\.org\/(?:publicdomain\/(?:zero\/1\.0|mark\/1\.0)|licenses\/by(?:-sa)?\/(?:2\.0|2\.5|3\.0|4\.0))\/$/;

export type PixelBox = [number, number, number, number];

export interface TrainingImage {
  path: string;
  sha256: string;
  width: number;
  height: number;
}

export interface TrainingPageInput {
  page_id: string;
  image: TrainingImage;
  line_boxes: PixelBox[];
}

interface TrainingSource {
  source_id: string;
  catalog_url: string;
  rights_uri: string;
}

export interface TrainingManifest {
  schema: typeof MANIFEST_SCHEMA;
  task_type: typeof PAGE_PASTE_TRAIN;
  split: "train";
  batch_id: string;
  title: string;
  source: TrainingSource;
  pages: TrainingPageInput[];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fields = (object: object, names: string[]) => Object.keys(object).every((key) => names.includes(key));
const dimension = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 20_000;
const id = (value: unknown): value is string => typeof value === "string" && TRAIN_ID.test(value);
const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password;
};

export function restrictedTrainingPath(path: string): boolean {
  return /(?:^|[\\/])(?:eval_refs|preregistration)(?:[\\/]|$)|(?:^|[\\/])runs[\\/][^\\/]*test|(?:^|[\\/])scans[\\/](?:ps_v1|nq1)(?:[\\/]|$)/i.test(path);
}

function box(value: unknown, width: number, height: number): value is PixelBox {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isSafeInteger)) return false;
  const [x0, y0, x1, y1] = value as PixelBox;
  return 0 <= x0 && x0 < x1 && x1 <= width && 0 <= y0 && y0 < y1 && y1 <= height;
}

function page(value: unknown, index: number): TrainingPageInput {
  const problem = (detail: string) => new Error(`pages[${index}]: ${detail}`);
  if (!record(value) || !fields(value, ["page_id", "image", "line_boxes"]) || !id(value.page_id)) throw problem("invalid page record");
  const image = value.image;
  if (!record(image) || !fields(image, ["path", "sha256", "width", "height"]) ||
    typeof image.path !== "string" || !IMAGE_PATH.test(image.path) || image.path.includes("..") ||
    typeof image.sha256 !== "string" || !SHA256.test(image.sha256) || !dimension(image.width) || !dimension(image.height) ||
    image.width * image.height > 50_000_000) throw problem("invalid full-page image");
  const { width, height } = image;
  const boxes = value.line_boxes as unknown;
  if (!Array.isArray(boxes) || boxes.length > 1000 || !boxes.every((b) => box(b, width, height))) {
    throw problem("line boxes must be pixel rectangles within the full-page image");
  }
  return { page_id: value.page_id, image: { path: image.path, sha256: image.sha256, width, height }, line_boxes: boxes };
}

export function parseTrainingManifest(input: unknown): TrainingManifest {
  if (!record(input) || !fields(input, ["schema", "task_type", "split", "batch_id", "title", "source", "pages"]) ||
    input.schema !== MANIFEST_SCHEMA || input.task_type !== PAGE_PASTE_TRAIN || input.split !== "train" ||
    !id(input.batch_id) || typeof input.title !== "string" || input.title.trim() === "" || input.title.length > 200 ||
    !Array.isArray(input.pages) || input.pages.length === 0) throw new Error("expected a page-paste training manifest with at least one page");
  const source = input.source;
  if (!record(source) || !fields(source, ["source_id", "catalog_url", "rights_uri"]) || !id(source.source_id) ||
    !httpsUrl(source.catalog_url) || typeof source.rights_uri !== "string" || !OPEN_RIGHTS.test(source.rights_uri)) {
    throw new Error("source needs an id, an HTTPS catalog URL and a supported open rights URI");
  }
  const pages = input.pages.map(page);
  for (const key of [pages.map((p) => p.page_id), pages.map((p) => p.image.path)]) {
    if (new Set(key).size !== pages.length) throw new Error("duplicate page id or image path");
  }
  return {
    schema: MANIFEST_SCHEMA, task_type: PAGE_PASTE_TRAIN, split: "train", batch_id: input.batch_id, title: input.title,
    source: { source_id: source.source_id, catalog_url: source.catalog_url, rights_uri: source.rights_uri }, pages,
  };
}
