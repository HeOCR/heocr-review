/**
 * The line verification contract between hocrgen and HeOCR Review (v1, 2026-11-07): the bundle
 * `line_verify_items.v1` (items.json and pages/) comes in, `line_verify_decisions.v1` goes out.
 * The contract text is HeOCR planning's `tasks/real-source-mapping/outputs/line_verify_contract.md`; the field
 * names here are exactly its own. Offsets (attention_spans) are code points, as Python counts them.
 */
import { pyLen, reviewerIdProblems, validDate } from "../reference_audit/schema";
import { MAX_TEXT_LENGTH } from "../types";

export const ITEMS_SCHEMA = "line_verify_items.v1";
export const DECISIONS_SCHEMA = "line_verify_decisions.v1";
export const SOURCES = ["wikisource_he_proofread", "benyehuda_nli_aligned"] as const;
export const PROVENANCES = ["wikisource_quality3_single_proofreader", "pby_human_typed_aligned"] as const;
export const STRATA = ["hard", "random"] as const;
export const RELEASE_SPLITS = ["train", "validation", "test"] as const;
export const DECISION_VALUES = ["exact", "edited", "unreadable", "misaligned"] as const;

/** Batch ids appear in the app's URLs (/api/batches/<id>/next). */
export const BATCH_ID = /^[A-Za-z0-9._-]{1,100}$/;
/** A page image inside the bundle: pages/<name>.<ext>, no subdirectories. */
export const PAGE_IMAGE = /^pages\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/;
/** Only openly licensed text may be imported. */
export const OPEN_LICENSE = /\b(CC BY-SA|CC BY|CC0|public domain)\b/i;

export type PixelBox = [number, number, number, number];

export interface LvPage {
  page_id: string;
  image: string;
  sha256: string;
  width: number;
  height: number;
  source: (typeof SOURCES)[number];
  book_id: string;
  book_title: string;
  page_label: string;
  text_license: string;
  attribution: string;
  release_split: (typeof RELEASE_SPLITS)[number] | null;
}

export interface LvItem {
  item_id: string;
  page_id: string;
  line_index: number;
  box: PixelBox;
  context_box: PixelBox;
  candidate_text: string;
  candidate_provenance: (typeof PROVENANCES)[number];
  alignment_score: number;
  attention_spans: [number, number][];
  difficulty: number;
  stratum: (typeof STRATA)[number];
  rank: number;
}

export interface LvItemsFile {
  schema_version: typeof ITEMS_SCHEMA;
  batch_id: string;
  description?: string;
  created_at: string;
  generator: { tool: string; ref?: string };
  pages: LvPage[];
  items: LvItem[];
}

export interface LvDecision {
  decision_id: string;
  item_id: string;
  reviewer: string;
  decision: (typeof DECISION_VALUES)[number];
  text?: string;
  /** Additive to the v1 contract: SHA-256 of the UTF-8 candidate_text the reviewer judged (see README). */
  candidate_sha256?: string;
  decided_at: string;
  checked_by: "human";
}

export interface LvDecisionsFile {
  schema_version: typeof DECISIONS_SCHEMA;
  batch_id: string;
  decisions: LvDecision[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const oneOf = (values: readonly string[], v: unknown) => (values as readonly unknown[]).includes(v);
const join = (values: readonly string[]) => values.join(", ");
const SHA256 = /^[0-9a-f]{64}$/;
/** A line is one line: no control characters at all (tab and line feed included). */
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;

/** Problems with a line's text, as a candidate or as a reviewer's edit (empty when valid). */
export function lineTextProblems(text: unknown): string[] {
  if (typeof text !== "string") return ["must be a string"];
  const problems: string[] = [];
  if (text.trim() === "") problems.push("must not be empty");
  if (text.length > MAX_TEXT_LENGTH) problems.push(`must be at most ${MAX_TEXT_LENGTH} characters`);
  if (LINE_CONTROL.test(text)) problems.push("must be one line without control characters");
  if (text !== text.normalize("NFC")) problems.push("must be NFC");
  return problems;
}

function pixelBoxProblems(name: string, box: unknown, page: Obj | undefined): string[] {
  if (!(Array.isArray(box) && box.length === 4 && box.every(isNum))) return [`${name} must be [x0, y0, x1, y1] in page pixels`];
  const [x0, y0, x1, y1] = box as PixelBox;
  if (!(0 <= x0 && x0 < x1 && 0 <= y0 && y0 < y1)) return [`${name} must have 0 <= x0 < x1 and 0 <= y0 < y1`];
  if (page && isInt(page.width) && isInt(page.height) && (x1 > page.width || y1 > page.height)) {
    return [`${name} must lie inside the page (${page.width} x ${page.height})`];
  }
  return [];
}

function pageProblems(page: Obj): string[] {
  const problems: string[] = [];
  if (!(typeof page.image === "string" && PAGE_IMAGE.test(page.image))) problems.push("image must be pages/<name>.jpg|jpeg|png|webp");
  if (!(typeof page.sha256 === "string" && SHA256.test(page.sha256))) problems.push("sha256 must be the image's SHA-256");
  for (const key of ["width", "height"]) if (!(isInt(page[key]) && (page[key] as number) > 0)) problems.push(`${key} must be a positive integer`);
  if (!oneOf(SOURCES, page.source)) problems.push(`source must be one of ${join(SOURCES)}`);
  for (const key of ["book_id", "book_title", "page_label"]) if (typeof page[key] !== "string") problems.push(`${key} must be a string`);
  if (!(nonEmpty(page.text_license) && OPEN_LICENSE.test(page.text_license))) {
    problems.push("text_license must name an open licence (CC BY-SA, CC BY, CC0 or public domain)");
  }
  if (!nonEmpty(page.attribution)) problems.push("attribution must say how to credit the source");
  if (!(page.release_split === null || oneOf(RELEASE_SPLITS, page.release_split))) {
    problems.push(`release_split must be one of ${join(RELEASE_SPLITS)} or null`);
  }
  return problems;
}

function itemProblems(item: Obj, page: Obj | undefined): string[] {
  const problems: string[] = [];
  if (!(isInt(item.line_index) && item.line_index >= 0)) problems.push("line_index must be a non-negative integer");
  problems.push(...pixelBoxProblems("box", item.box, page), ...pixelBoxProblems("context_box", item.context_box, page));
  problems.push(...lineTextProblems(item.candidate_text).map((p) => `candidate_text ${p}`));
  if (!oneOf(PROVENANCES, item.candidate_provenance)) problems.push(`candidate_provenance must be one of ${join(PROVENANCES)}`);
  for (const key of ["alignment_score", "difficulty"]) {
    if (!(isNum(item[key]) && (item[key] as number) >= 0 && (item[key] as number) <= 1)) problems.push(`${key} must be a number in [0, 1]`);
  }
  if (!oneOf(STRATA, item.stratum)) problems.push(`stratum must be one of ${join(STRATA)}`);
  if (!(isInt(item.rank) && item.rank >= 0)) problems.push("rank must be a non-negative integer");
  const spans = item.attention_spans;
  if (!Array.isArray(spans)) problems.push("attention_spans must be a list of [start, end]");
  else if (typeof item.candidate_text === "string") {
    const n = pyLen(item.candidate_text);
    for (const span of spans) {
      if (!(Array.isArray(span) && span.length === 2 && isInt(span[0]) && isInt(span[1]) && 0 <= span[0] && span[0] <= span[1] && span[1] <= n)) {
        problems.push(`attention_spans: ${JSON.stringify(span)} must be [start, end] code-point offsets with 0 <= start <= end <= ${n}`);
      }
    }
  }
  return problems;
}

/** Every problem with a line_verify_items.v1 file (empty when valid). */
export function itemsFileProblems(payload: unknown): string[] {
  if (!isObj(payload) || payload.schema_version !== ITEMS_SCHEMA) return [`schema_version must be ${ITEMS_SCHEMA}`];
  const problems: string[] = [];
  if (!(typeof payload.batch_id === "string" && BATCH_ID.test(payload.batch_id))) {
    problems.push("batch_id must be 1-100 letters, digits, '.', '_' or '-'");
  }
  if (!validDate(payload.created_at)) problems.push("created_at must be a YYYY-MM-DD date");
  if (!(isObj(payload.generator) && nonEmpty(payload.generator.tool))) problems.push("generator.tool must name the exporter");
  const pages = new Map<string, Obj>();
  if (!Array.isArray(payload.pages) || payload.pages.length === 0) problems.push("pages must list every page image");
  for (const page of Array.isArray(payload.pages) ? payload.pages : []) {
    const id = isObj(page) ? page.page_id : undefined;
    if (!isObj(page) || !nonEmpty(id) || pages.has(id)) {
      problems.push(`page ${JSON.stringify(id ?? null)}: page_id missing or listed twice`);
      continue;
    }
    pages.set(id, page);
    problems.push(...pageProblems(page).map((p) => `page ${id}: ${p}`));
  }
  const ids = new Set<string>();
  if (!Array.isArray(payload.items) || payload.items.length === 0) problems.push("items must list at least one line");
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    const id = isObj(item) ? item.item_id : undefined;
    if (!isObj(item) || !nonEmpty(id) || ids.has(id)) {
      problems.push(`item ${JSON.stringify(id ?? null)}: item_id missing or listed twice`);
      continue;
    }
    ids.add(id);
    const page = typeof item.page_id === "string" ? pages.get(item.page_id) : undefined;
    if (!page) problems.push(`item ${id}: page_id is not a page of this bundle`);
    problems.push(...itemProblems(item, page).map((p) => `item ${id}: ${p}`));
  }
  return problems;
}

/** hocrgen's decision_id convention: one decision per reviewer per item. */
export function decisionId(itemId: string, reviewer: string): string {
  return `decision:${itemId}:${reviewer}`;
}

export interface ItemRef {
  item_id: string;
  candidate_text: string;
  candidate_sha256?: string;
}

/** Every problem with a line_verify_decisions.v1 file, checked against its items. */
export function decisionsFileProblems(payload: unknown, batchId: string, items: ItemRef[]): string[] {
  if (!isObj(payload) || payload.schema_version !== DECISIONS_SCHEMA) return [`schema_version must be ${DECISIONS_SCHEMA}`];
  const problems: string[] = [];
  if (payload.batch_id !== batchId) problems.push("batch_id must match the items' batch_id");
  if (!Array.isArray(payload.decisions)) return [...problems, "decisions must be a list"];
  const known = new Map(items.map((i) => [i.item_id, i]));
  const ids = new Set<unknown>();
  const decided = new Set<string>();
  payload.decisions.forEach((raw, index) => {
    const d: Obj = isObj(raw) ? raw : {};
    const label = `decision ${nonEmpty(d.decision_id) ? d.decision_id : index + 1}`;
    const item = typeof d.item_id === "string" ? known.get(d.item_id) : undefined;
    if (!item) problems.push(`${label}: item_id ${JSON.stringify(d.item_id ?? null)} is not an item of ${batchId}`);
    if (!nonEmpty(d.decision_id)) problems.push(`${label}: decision_id must be a non-empty string`);
    else if (ids.has(d.decision_id)) problems.push(`${label}: decision_id listed twice`);
    else if (typeof d.item_id === "string" && typeof d.reviewer === "string" && d.decision_id !== decisionId(d.item_id, d.reviewer)) {
      problems.push(`${label}: decision_id must be decision:<item_id>:<reviewer>`);
    }
    ids.add(d.decision_id);
    const key = `${String(d.item_id)}\u0000${String(d.reviewer)}`;
    if (item && decided.has(key)) problems.push(`${label}: a second decision by ${String(d.reviewer)} for ${item.item_id}; one per reviewer`);
    decided.add(key);
    if (!oneOf(DECISION_VALUES, d.decision)) problems.push(`${label}: decision must be one of ${join(DECISION_VALUES)}`);
    if (d.decision === "edited") {
      const textProblems = lineTextProblems(d.text);
      if (textProblems.length) problems.push(...textProblems.map((p) => `${label}: text ${p}`));
      else if (item && d.text === item.candidate_text) problems.push(`${label}: an edit equal to the candidate is exact; record exact`);
    } else if ("text" in d) problems.push(`${label}: only an edited decision carries text`);
    if (d.candidate_sha256 !== undefined && !(typeof d.candidate_sha256 === "string" && SHA256.test(d.candidate_sha256))) {
      problems.push(`${label}: candidate_sha256 must be a SHA-256`);
    } else if (item?.candidate_sha256 && d.candidate_sha256 !== undefined && d.candidate_sha256 !== item.candidate_sha256) {
      problems.push(`${label}: candidate_sha256 is not the item's candidate_text`);
    }
    problems.push(...reviewerIdProblems(d.reviewer).map((p) => `${label}: ${p}`));
    if (!validDate(d.decided_at)) problems.push(`${label}: decided_at must be a YYYY-MM-DD date`);
    if (d.checked_by !== "human") problems.push(`${label}: checked_by must be human`);
  });
  return problems;
}
