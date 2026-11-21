/**
 * The line verification contract between hocrgen and HeOCR Review (v1, 2026-11-07; decisions v1.1, 2026-11-11): the
 * bundle `line_verify_items.v1` (items.json and pages/) comes in, `line_verify_decisions.v1.1` goes out. v1.1 is
 * additive: it adds the `pointed_print` decision (the letters match the print, but the print has niqqud or marks the
 * candidate lacks), which may carry the corrected letters as `text`.
 * The contract text is HeOCR planning's `tasks/real-source-mapping/outputs/line_verify_contract.md`; the field
 * names here are exactly its own. Offsets (attention_spans) are code points, as Python counts them.
 *
 * Items v1.1 (2026-11-18, for data-collection's P-hist eval hold-out) is additive: edition-text sources and
 * provenances, a page `script` (square or rashi), an item `precheck` ("look here", never a correction) and a top-level
 * `blind_second_pass` (the item ids that get a blind second pass). Decisions on a v1.1 batch are exported as
 * `line_verify_decisions.v1.2`: v1.1 plus each decision's `pass` (1, or 2 for the blind second pass). Pass 2 is typed
 * from a blank box (heocr-eval, 2026-11-18: showing the candidate again would reproduce the bias it measures), so its
 * decisions are `typed` (the reviewer's text), `pointed_print` (with the letters typed, no niqqud), `unreadable` or
 * `misaligned`, and say `same_reviewer` (the pass-2 reviewer also decided the line's pass 1: intra-rater).
 *
 * Items v1.2 (heocr-eval's P-hist page rule, 2026-11-18): every kraken line of a scored page gets a reference. An item
 * is `kind` "verify" (an edition candidate, as before) or "type" (no candidate: typed from a blank box, including
 * running heads, page numbers, catchwords and glosses); each page says its `segmenter`, `kraken_lines` and
 * `book_group`, and its items cover line_index 0..kraken_lines-1 exactly once. A typed line's box problems are H's:
 * not_one_line, no_text, continued. Decisions on a v1.2 batch are exported as `line_verify_decisions.v1.3`: v1.2 plus
 * each decision's `kind`, `box_reason` on not_on_page, and a `pages` list saying which pages are done and how many
 * of their lines are unreadable. On a v1.2 verify line, `misaligned` carries the line as typed (`text`).
 */
import { pyLen, reviewerIdProblems, validDate } from "../reference_audit/schema";
import { hasNiqqud } from "../../shared/niqqud";
import { OPEN_LICENCE_PROBLEM, isOpenLicence } from "../../shared/licence";
import { MAX_TEXT_LENGTH } from "../types";

export const ITEMS_SCHEMA = "line_verify_items.v1";
export const ITEMS_SCHEMA_V11 = "line_verify_items.v1.1";
export const ITEMS_SCHEMA_V12 = "line_verify_items.v1.2";
/**
 * v1.3 (heocr-eval's test pre-fill protocol, amendment 1): v1.2 plus an optional draft on a "type" item, a model's
 * reading shown in the typing box for the reviewer to correct. The draft is one unpointed line (letters only, as a
 * typed line), and its provenance names the model and the prompt's sha256 (LLM_PROVENANCE). Pass 2 never shows it.
 */
export const ITEMS_SCHEMA_V13 = "line_verify_items.v1.3";
export const ITEMS_SCHEMAS = [ITEMS_SCHEMA, ITEMS_SCHEMA_V11, ITEMS_SCHEMA_V12, ITEMS_SCHEMA_V13] as const;
/** A draft's provenance: llm:<model>:<sha256 of the prompt>. */
export const LLM_PROVENANCE = /^llm:[a-z0-9.-]+:[0-9a-f]{64}$/;
/** 0 for v1, 1 for v1.1, 2 for v1.2, 3 for v1.3: each level adds to the one before. */
export const itemsLevel = (schema: unknown): number => (ITEMS_SCHEMAS as readonly unknown[]).indexOf(schema);
export const DECISIONS_SCHEMA = "line_verify_decisions.v1.1";
/** Decisions on a v1.1 batch: v1.1 plus `pass` on every decision. */
export const DECISIONS_SCHEMA_V12 = "line_verify_decisions.v1.2";
/** Decisions on a v1.2 batch: v1.2 plus `kind` on every decision, `box_reason`, and the pages list. */
export const DECISIONS_SCHEMA_V13 = "line_verify_decisions.v1.3";
/** Decisions on a volunteer_v1 batch (docs/specs/line_verify_volunteer_resolution_v1.md): v1.3 plus counted, step, lines. */
export const DECISIONS_SCHEMA_V14 = "line_verify_decisions.v1.4";
/** Decisions on a volunteer_v1_1 batch (docs/specs/line_verify_phist_gold_v1_1.md): v1.4 plus the P-hist gold section. */
export const DECISIONS_SCHEMA_V15 = "line_verify_decisions.v1.5";
export const VOTE_STEPS = ["pass1", "pass2", "third", "maintainer", "fourth", "uncounted"] as const;
export const NOT_COUNTED_REASONS = ["fewer_than_20_gold", "below_floor", "excluded_by_admin", "fewer_than_15_phist_gold", "below_phist_floor", "not_recorded"] as const;
export const LINE_RESOLUTIONS = ["agreed", "majority", "to_maintainer", "unresolved", "pending"] as const;
/** Every version validates; a v1 file may not use `pointed_print`, only v1.2+ carries `pass`, only v1.3 `kind`. */
export const DECISIONS_SCHEMAS = ["line_verify_decisions.v1", DECISIONS_SCHEMA, DECISIONS_SCHEMA_V12, DECISIONS_SCHEMA_V13, DECISIONS_SCHEMA_V14, DECISIONS_SCHEMA_V15] as const;
export const KINDS = ["verify", "type"] as const;
/** A typed line's box problems (as in H): exported as decision not_on_page with this box_reason. */
export const BOX_REASONS = ["not_one_line", "no_text", "continued"] as const;
/** What a reviewer may answer on a typed line (either pass), as stored; the box problems export as not_on_page. */
export const TYPE_APP_VALUES = ["typed", "pointed_print", "unreadable", ...BOX_REASONS] as const;
/** A typed line's decisions as exported (v1.3). */
export const TYPE_DECISION_VALUES = ["typed", "pointed_print", "unreadable", "not_on_page"] as const;
/**
 * reshumot_scanned and knesset_plenary: the mid-century pages of the admin-only line-level gold batch
 * (newprinted_midcentury_goldlines_v0, heocr-restricted-eval#95), live on production since 2026-11-19.
 */
export const SOURCES = ["wikisource_he_proofread", "benyehuda_nli_aligned", "reshumot_scanned", "knesset_plenary"] as const;
export const PROVENANCES = ["wikisource_quality3_single_proofreader", "pby_human_typed_aligned", "publisher_ocr_layer"] as const;
/** v1.1 adds edition texts: the candidate is a published edition's text, never OCR. */
/** v1.2 adds hash_eval: HASH's handwritten eval pages (h_eval_v1), typed from scratch, no candidate. */
export const SOURCES_V11 = [...SOURCES, "sefaria_edition", "gutenberg_edition", "benyehuda_text", "wikisource_he", "hash_eval"] as const;
export const PROVENANCES_V11 = [
  ...PROVENANCES,
  "sefaria_exact_edition",
  "gutenberg_exact_edition",
  "pby_human_typed",
  "wikisource_quality4_validated",
  "wikisource_quality1_unproofread",
] as const;
/** The page's typeface (v1.1): Rashi script is its own stratum. */
export const SCRIPTS = ["square", "rashi", "handwriting"] as const;
/** Why the agent pre-check thinks a candidate is likely wrong (v1.1). */
export const PRECHECK_REASONS = ["edge_mismatch", "spelling", "digits"] as const;
/** A line's blind second pass is the proposal `<item_id>@pass2` (as in page_review). */
export const PASS2_SUFFIX = "@pass2";
/** How the export's blind_second_pass.sha256 is computed, so a reader can check it against the bundle. */
export const BLIND_LIST_SHA256_OF = "the blind_second_pass item ids, sorted (by code unit), joined by \"\\n\", as UTF-8";
export const PASS2_REVIEWERS = ["same", "other"] as const;
export const STRATA = ["hard", "random"] as const;
export const RELEASE_SPLITS = ["train", "validation", "test"] as const;
export const DECISION_VALUES_V1 = ["exact", "edited", "unreadable", "misaligned"] as const;
export const DECISION_VALUES = [...DECISION_VALUES_V1, "pointed_print"] as const;
/** A blind second pass (v1.2): typed from a blank box, never a verdict on a candidate it was not shown. */
export const PASS2_DECISION_VALUES = ["typed", "pointed_print", "unreadable", "misaligned"] as const;
export { hasNiqqud };

/** Batch ids appear in the app's URLs (/api/batches/<id>/next). */
export const BATCH_ID = /^[A-Za-z0-9._-]{1,100}$/;
/** A page image inside the bundle: pages/<name>.<ext>, no subdirectories. */
export const PAGE_IMAGE = /^pages\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp)$/;
export type PixelBox = [number, number, number, number];

export interface LvPage {
  page_id: string;
  image: string;
  sha256: string;
  width: number;
  height: number;
  source: (typeof SOURCES_V11)[number];
  book_id: string;
  book_title: string;
  page_label: string;
  text_license: string;
  attribution: string;
  release_split: (typeof RELEASE_SPLITS)[number] | null;
  /** v1.1 and later, and required there. */
  script?: (typeof SCRIPTS)[number];
  /** v1.2: the segmenter whose lines the items cover, e.g. "kraken blla 5.2.9". */
  segmenter?: string;
  /** v1.2: how many lines the segmenter found; the page's items cover line_index 0..kraken_lines-1 exactly once. */
  kraken_lines?: number;
  /** v1.2: the book group the page belongs to (e.g. early or later prints); a two-typings switch acts per group. */
  book_group?: string;
}

export interface LvPrecheck {
  likely_wrong: boolean;
  /** Empty exactly when likely_wrong is false. */
  reasons: (typeof PRECHECK_REASONS)[number][];
}

export interface LvItem {
  item_id: string;
  page_id: string;
  line_index: number;
  box: PixelBox;
  context_box: PixelBox;
  /** null on a v1.2 "type" item. */
  candidate_text: string | null;
  candidate_provenance: (typeof PROVENANCES_V11)[number] | null;
  alignment_score: number | null;
  attention_spans: [number, number][];
  difficulty: number;
  stratum: (typeof STRATA)[number];
  rank: number;
  /** v1.1 and later, optional; never on a "type" item. */
  precheck?: LvPrecheck;
  /** v1.2 only, and required there. */
  kind?: (typeof KINDS)[number];
}

export interface LvItemsFile {
  schema_version: (typeof ITEMS_SCHEMAS)[number];
  batch_id: string;
  description?: string;
  created_at: string;
  generator: { tool: string; ref?: string };
  pages: LvPage[];
  items: LvItem[];
  /** v1.1 only: the items that get a blind second pass (a seeded sample; say the seed in `description`). */
  blind_second_pass?: string[];
}

export interface LvDecision {
  decision_id: string;
  item_id: string;
  reviewer: string;
  method?: "page_sweep" | "line_unplanted";
  decision: (typeof DECISION_VALUES)[number] | (typeof PASS2_DECISION_VALUES)[number] | (typeof TYPE_DECISION_VALUES)[number];
  /** v1.3 only, and required there. */
  kind?: (typeof KINDS)[number];
  /** v1.4 (volunteer_v1 batches): whether it counted, why not, and its routing step. */
  counted?: boolean;
  not_counted_reason?: (typeof NOT_COUNTED_REASONS)[number];
  step?: (typeof VOTE_STEPS)[number];
  /** v1.3: exactly on not_on_page. */
  box_reason?: (typeof BOX_REASONS)[number];
  text?: string;
  /** Additive to the v1 contract: SHA-256 of the UTF-8 candidate_text the reviewer judged (see README). */
  candidate_sha256?: string;
  /** Pass-1 decisions on a typed line with a draft (items v1.3): the draft's provenance; candidate_sha256 is the draft's. */
  prefill_provenance?: string;
  /** v1.2 only, and required there: 2 for the blind second pass. */
  pass?: 1 | 2;
  /** v1.2, pass-2 decisions only, and required there: the reviewer also decided the line's pass 1. */
  same_reviewer?: boolean;
  /** v1.2, pass-1 decisions on blind lines only: the pass-1 answer changed after the reviewer first decided pass 2. */
  revised_after_pass2?: boolean;
  /** With revised_after_pass2: true, the pass-1 decision that stood then (null if none did). */
  pass1_at_pass2?: { decision: LvDecision["decision"]; text?: string; decided_at: string } | null;
  decided_at: string;
  checked_by: "human";
}

export interface LvDecisionsFile {
  schema_version: (typeof DECISIONS_SCHEMAS)[number];
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

function pageProblems(page: Obj, level: number): string[] {
  const v11 = level >= 1;
  const problems: string[] = [];
  if (!(typeof page.image === "string" && PAGE_IMAGE.test(page.image))) problems.push("image must be pages/<name>.jpg|jpeg|png|webp");
  if (!(typeof page.sha256 === "string" && SHA256.test(page.sha256))) problems.push("sha256 must be the image's SHA-256");
  for (const key of ["width", "height"]) if (!(isInt(page[key]) && (page[key] as number) > 0)) problems.push(`${key} must be a positive integer`);
  const sources = v11 ? SOURCES_V11 : SOURCES;
  if (!oneOf(sources, page.source)) problems.push(`source must be one of ${join(sources)}`);
  for (const key of ["book_id", "book_title", "page_label"]) if (typeof page[key] !== "string") problems.push(`${key} must be a string`);
  if (!isOpenLicence(page.text_license)) problems.push(OPEN_LICENCE_PROBLEM);
  if (!nonEmpty(page.attribution)) problems.push("attribution must say how to credit the source");
  if (!(page.release_split === null || oneOf(RELEASE_SPLITS, page.release_split))) {
    problems.push(`release_split must be one of ${join(RELEASE_SPLITS)} or null`);
  }
  if (v11 && !oneOf(SCRIPTS, page.script)) problems.push(`script must be one of ${join(SCRIPTS)}`);
  if (!v11 && "script" in page) problems.push(`script is a ${ITEMS_SCHEMA_V11} field`);
  if (level >= 2) {
    if (!nonEmpty(page.segmenter)) problems.push("segmenter must name the line segmenter and its version");
    if (!(isInt(page.kraken_lines) && page.kraken_lines >= 0)) problems.push("kraken_lines must be a non-negative integer");
    if (!(typeof page.book_group === "string" && BATCH_ID.test(page.book_group))) problems.push("book_group must be 1-100 letters, digits, '.', '_' or '-'");
  } else {
    for (const key of ["segmenter", "kraken_lines", "book_group"]) if (key in page) problems.push(`${key} is a ${ITEMS_SCHEMA_V12} field`);
  }
  return problems;
}

function precheckProblems(precheck: unknown): string[] {
  if (!(isObj(precheck) && typeof precheck.likely_wrong === "boolean" && Array.isArray(precheck.reasons))) {
    return ["precheck must be { likely_wrong: boolean, reasons: [...] }"];
  }
  const problems: string[] = [];
  const reasons = precheck.reasons as unknown[];
  if (!reasons.every((r) => oneOf(PRECHECK_REASONS, r)) || new Set(reasons).size !== reasons.length) {
    problems.push(`precheck.reasons must be distinct values of ${join(PRECHECK_REASONS)}`);
  }
  if (precheck.likely_wrong !== reasons.length > 0) problems.push("precheck.reasons must be given exactly when likely_wrong is true");
  return problems;
}

function itemProblems(item: Obj, page: Obj | undefined, level: number): string[] {
  const v11 = level >= 1;
  const problems: string[] = [];
  if (level >= 2 && !oneOf(KINDS, item.kind)) problems.push(`kind must be one of ${join(KINDS)}`);
  if (level < 2 && "kind" in item) problems.push(`kind is a ${ITEMS_SCHEMA_V12} field`);
  if (level >= 2 && item.kind === "type") return [...problems, ...typeItemProblems(item, page, level)];
  if (typeof item.item_id === "string" && item.item_id.includes(PASS2_SUFFIX)) problems.push(`item_id must not contain ${PASS2_SUFFIX}`);
  if (!(isInt(item.line_index) && item.line_index >= 0)) problems.push("line_index must be a non-negative integer");
  problems.push(...pixelBoxProblems("box", item.box, page), ...pixelBoxProblems("context_box", item.context_box, page));
  problems.push(...lineTextProblems(item.candidate_text).map((p) => `candidate_text ${p}`));
  const provenances = v11 ? PROVENANCES_V11 : PROVENANCES;
  if (!oneOf(provenances, item.candidate_provenance)) problems.push(`candidate_provenance must be one of ${join(provenances)}`);
  if ("precheck" in item) {
    if (v11 && item.precheck !== null) problems.push(...precheckProblems(item.precheck));
    else problems.push(`precheck is a ${ITEMS_SCHEMA_V11} field`);
  }
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

/** Every problem with a typed line's draft (v1.3): it must be what the reviewer could save as typed, unchanged. */
export function draftProblems(draft: unknown): string[] {
  const problems = lineTextProblems(draft);
  if (problems.length) return problems;
  const text = draft as string;
  if (text !== text.normalize("NFC")) return ["must be NFC"];
  if (text !== text.trim() || /\s{2,}/u.test(text)) return ["must have no edge or repeated whitespace"];
  if (hasNiqqud(text)) return ["must hold the letters only, without niqqud or marks"];
  return [];
}

/** A typed line: the segmenter's box, no candidate (v1.3: or a model's draft), nothing else to show but the scan. */
function typeItemProblems(item: Obj, page: Obj | undefined, level: number): string[] {
  const problems: string[] = [];
  if (typeof item.item_id === "string" && item.item_id.includes(PASS2_SUFFIX)) problems.push(`item_id must not contain ${PASS2_SUFFIX}`);
  if (!(isInt(item.line_index) && item.line_index >= 0)) problems.push("line_index must be a non-negative integer");
  problems.push(...pixelBoxProblems("box", item.box, page), ...pixelBoxProblems("context_box", item.context_box, page));
  if (level >= 3 && item.candidate_text !== null) {
    problems.push(...draftProblems(item.candidate_text).map((p) => `candidate_text (a draft) ${p}`));
    if (!(typeof item.candidate_provenance === "string" && LLM_PROVENANCE.test(item.candidate_provenance))) {
      problems.push("candidate_provenance of a draft must be llm:<model>:<prompt sha256>");
    }
  } else if (level >= 3) {
    if (item.candidate_provenance !== null) problems.push("candidate_provenance must be null without a draft");
  } else for (const key of ["candidate_text", "candidate_provenance"]) if (item[key] !== null) problems.push(`${key} must be null on a type item`);
  // No candidate, so nothing was aligned: null, or a number (ignored).
  if (!(item.alignment_score === null || (isNum(item.alignment_score) && item.alignment_score >= 0 && item.alignment_score <= 1))) {
    problems.push("alignment_score must be null or a number in [0, 1] on a type item");
  }
  if (!(Array.isArray(item.attention_spans) && item.attention_spans.length === 0)) problems.push("attention_spans must be [] on a type item");
  if ("precheck" in item && item.precheck !== null) problems.push("a type item has no precheck");
  if (!(isNum(item.difficulty) && item.difficulty >= 0 && item.difficulty <= 1)) problems.push("difficulty must be a number in [0, 1]");
  if (!oneOf(STRATA, item.stratum)) problems.push(`stratum must be one of ${join(STRATA)}`);
  if (!(isInt(item.rank) && item.rank >= 0)) problems.push("rank must be a non-negative integer");
  return problems;
}

/** Every problem with a line_verify_items.v1, .v1.1, .v1.2 or .v1.3 file (empty when valid). */
export function itemsFileProblems(payload: unknown): string[] {
  if (!isObj(payload) || !oneOf(ITEMS_SCHEMAS, payload.schema_version)) return [`schema_version must be one of ${join(ITEMS_SCHEMAS)}`];
  const level = itemsLevel(payload.schema_version);
  const v11 = level >= 1;
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
    problems.push(...pageProblems(page, level).map((p) => `page ${id}: ${p}`));
  }
  const ids = new Set<string>();
  if (!Array.isArray(payload.items)) problems.push("items must be a list of lines");
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    const id = isObj(item) ? item.item_id : undefined;
    if (!isObj(item) || !nonEmpty(id) || ids.has(id)) {
      problems.push(`item ${JSON.stringify(id ?? null)}: item_id missing or listed twice`);
      continue;
    }
    ids.add(id);
    const page = typeof item.page_id === "string" ? pages.get(item.page_id) : undefined;
    if (!page) problems.push(`item ${id}: page_id is not a page of this bundle`);
    problems.push(...itemProblems(item, page, level).map((p) => `item ${id}: ${p}`));
  }
  // v1.2: every segmenter line of every page has exactly one item, so no printed line goes without a reference.
  if (level >= 2) {
    const lines = new Map<string, number[]>();
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      if (isObj(item) && typeof item.page_id === "string" && isInt(item.line_index)) lines.set(item.page_id, [...(lines.get(item.page_id) ?? []), item.line_index]);
    }
    for (const [id, page] of pages) {
      if (!isInt(page.kraken_lines) || page.kraken_lines < 0) continue;
      const got = lines.get(id) ?? [];
      const missing = [...Array(page.kraken_lines).keys()].filter((i) => !got.includes(i));
      const extra = got.filter((i, k) => i >= (page.kraken_lines as number) || got.indexOf(i) !== k);
      if (missing.length || extra.length) {
        problems.push(
          `page ${id}: items must cover line_index 0..${page.kraken_lines - 1} exactly once` +
            (missing.length ? `; missing ${missing.slice(0, 10).join(", ")}` : "") +
            (extra.length ? `; extra or repeated ${extra.slice(0, 10).join(", ")}` : ""),
        );
      }
    }
  }
  if ("blind_second_pass" in payload) {
    const blind = payload.blind_second_pass;
    if (!v11) problems.push(`blind_second_pass is a ${ITEMS_SCHEMA_V11} field`);
    else if (!Array.isArray(blind)) problems.push("blind_second_pass must be a list of item ids");
    else {
      const seen = new Set<unknown>();
      for (const b of blind) {
        if (seen.has(b)) problems.push(`blind_second_pass: ${JSON.stringify(b)} listed twice`);
        else if (!(typeof b === "string" && ids.has(b))) problems.push(`blind_second_pass: ${JSON.stringify(b)} is not an item of this bundle`);
        seen.add(b);
      }
    }
  }
  return problems;
}

/** hocrgen's decision_id convention: one decision per reviewer per item. */
export function decisionId(itemId: string, reviewer: string): string {
  return `decision:${itemId}:${reviewer}`;
}

export interface ItemRef {
  item_id: string;
  /** "" on a typed line. */
  candidate_text: string;
  /** v1.3: the item's kind. */
  kind?: (typeof KINDS)[number];
  candidate_sha256?: string;
  /** A typed line with a draft (items v1.3): its pass-1 decisions carry the draft's candidate_sha256 and this. */
  prefill_provenance?: string;
  /** The line has a blind second pass (v1.2 decisions may then carry pass 2). */
  blind?: boolean;
}

/** Every problem with a line_verify_decisions.v1, .v1.1 or .v1.2 file, checked against its items. */
export function decisionsFileProblems(payload: unknown, batchId: string, items: ItemRef[]): string[] {
  if (!isObj(payload) || !oneOf(DECISIONS_SCHEMAS, payload.schema_version)) return [`schema_version must be one of ${join(DECISIONS_SCHEMAS)}`];
  const allowed: readonly string[] = payload.schema_version === "line_verify_decisions.v1" ? DECISION_VALUES_V1 : DECISION_VALUES;
  const v15 = payload.schema_version === DECISIONS_SCHEMA_V15;
  const v14 = payload.schema_version === DECISIONS_SCHEMA_V14 || v15;
  const v13 = payload.schema_version === DECISIONS_SCHEMA_V13 || v14;
  const v12 = payload.schema_version === DECISIONS_SCHEMA_V12 || v13;
  const problems: string[] = [];
  if (v13) {
    const two = isObj(payload.two_typings) ? payload.two_typings : {};
    if (!(Array.isArray(two.groups) && two.groups.every((g) => typeof g === "string"))) problems.push("two_typings.groups must be a list of book groups");
    if (!(two.set_at === null || typeof two.set_at === "string")) problems.push("two_typings.set_at must be a timestamp or null");
    if (!Array.isArray(payload.pages)) problems.push("pages must list every page with its kraken_lines, resolved and done");
    else {
      for (const pg of payload.pages as unknown[]) {
        const ok =
          isObj(pg) &&
          nonEmpty(pg.page_id) &&
          isInt(pg.kraken_lines) &&
          isInt(pg.resolved) &&
          pg.resolved >= 0 &&
          pg.resolved <= pg.kraken_lines &&
          pg.done === (pg.resolved === pg.kraken_lines) &&
          isInt(pg.unreadable) &&
          pg.unreadable >= 0 &&
          pg.unreadable <= pg.kraken_lines;
        if (!ok) problems.push(`pages: ${JSON.stringify(isObj(pg) ? pg.page_id : pg)} must give kraken_lines, resolved (at most kraken_lines), done and unreadable`);
      }
    }
  }
  if (v12) {
    const mode = isObj(payload.pass2_reviewer) ? payload.pass2_reviewer : {};
    if (!oneOf(PASS2_REVIEWERS, mode.mode)) problems.push(`pass2_reviewer.mode must be one of ${join(PASS2_REVIEWERS)}`);
    if (!(mode.set_at === null || typeof mode.set_at === "string")) problems.push("pass2_reviewer.set_at must be a timestamp or null");
    const list = isObj(payload.blind_second_pass) ? payload.blind_second_pass : {};
    if (!(isInt(list.count) && list.count >= 0 && typeof list.sha256 === "string" && SHA256.test(list.sha256))) {
      problems.push("blind_second_pass must give the list's count and sha256");
    } else if (list.count !== items.filter((i) => i.blind).length) problems.push("blind_second_pass.count is not the number of blind lines");
  }
  if (v14) {
    if (payload.resolution !== (v15 ? "volunteer_v1_1" : "volunteer_v1")) problems.push(`resolution must be ${v15 ? "volunteer_v1_1" : "volunteer_v1"}`);
    if (!nonEmpty(payload.gate_batch_id)) problems.push("gate_batch_id must name the standing batch");
    if (!(typeof payload.line_fold_v1_sha256 === "string" && SHA256.test(payload.line_fold_v1_sha256))) problems.push("line_fold_v1_sha256 must be a SHA-256");
    const exported = new Set(Array.isArray(payload.decisions) ? (payload.decisions as Obj[]).map((d) => d.decision_id) : []);
    const knownItems = new Set(items.map((i) => i.item_id));
    if (!Array.isArray(payload.lines)) problems.push("lines must list every line's resolution");
    else {
      for (const l of payload.lines as unknown[]) {
        const line: Obj = isObj(l) ? l : {};
        const at = `line ${JSON.stringify(line.item_id ?? null)}`;
        if (!(typeof line.item_id === "string" && knownItems.has(line.item_id))) problems.push(`${at}: not an item of ${batchId}`);
        if (!oneOf(LINE_RESOLUTIONS, line.resolution)) problems.push(`${at}: resolution must be one of ${join(LINE_RESOLUTIONS)}`);
        const resolved = line.resolution === "agreed" || line.resolution === "majority";
        if (resolved !== (isObj(line.reference) && Array.isArray(line.pair))) problems.push(`${at}: a reference and its pair come exactly with agreed or majority`);
        if (Array.isArray(line.pair) && !(line.pair.length === 2 && line.pair.every((id) => exported.has(id)))) problems.push(`${at}: pair must name two exported decisions`);
      }
    }
  }
  if (v15) {
    const pg = isObj(payload.phist_gold) ? payload.phist_gold : {};
    if (!(nonEmpty(pg.file) && typeof pg.sha256 === "string" && SHA256.test(pg.sha256) && isInt(pg.lines) && Array.isArray(pg.pulled))) {
      problems.push("phist_gold must give the gold file, its sha256, its line count and the pulled gold_ids");
    }
    if (!Array.isArray(payload.gold)) problems.push("gold must list every gold decision");
    else {
      const seen = new Set<unknown>();
      for (const g of payload.gold as unknown[]) {
        const r: Obj = isObj(g) ? g : {};
        const at = `gold decision ${JSON.stringify(r.decision_id ?? null)}`;
        if (!nonEmpty(r.decision_id) || seen.has(r.decision_id)) problems.push(`${at}: decision_id must be unique`);
        seen.add(r.decision_id);
        if (!nonEmpty(r.gold_id) || !nonEmpty(r.reviewer)) problems.push(`${at}: gold_id and reviewer are required`);
        if (!(r.hit === true || r.hit === false || r.hit === null)) problems.push(`${at}: hit must be true, false or null (not graded)`);
        if (typeof r.pulled !== "boolean") problems.push(`${at}: pulled must be a boolean`);
      }
    }
  }
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
    if (v12) {
      if (d.pass !== 1 && d.pass !== 2) problems.push(`${label}: pass must be 1 or 2`);
      else if (d.pass === 2 && item && !item.blind) problems.push(`${label}: ${item.item_id} has no blind second pass`);
      if ("revised_after_pass2" in d && !(d.pass === 1 && item?.blind && typeof d.revised_after_pass2 === "boolean")) {
        problems.push(`${label}: revised_after_pass2 is a boolean on pass-1 decisions of blind lines only`);
      } else if ("revised_after_pass2" in d && (d.revised_after_pass2 === true) !== "pass1_at_pass2" in d) {
        problems.push(`${label}: pass1_at_pass2 comes exactly with revised_after_pass2: true`);
      }
    } else {
      for (const key of ["pass", "same_reviewer", "revised_after_pass2", "pass1_at_pass2"]) if (key in d) problems.push(`${label}: ${key} is a ${DECISIONS_SCHEMA_V12} field`);
    }
    if (v13 && !oneOf(KINDS, d.kind)) problems.push(`${label}: kind must be one of ${join(KINDS)}`);
    else if (v13 && item?.kind && d.kind !== item.kind) problems.push(`${label}: kind must be the item's (${item.kind})`);
    if (!v13) for (const key of ["kind", "box_reason"]) if (key in d) problems.push(`${label}: ${key} is a ${DECISIONS_SCHEMA_V13} field`);
    if (v14) {
      if (typeof d.counted !== "boolean") problems.push(`${label}: counted must be a boolean`);
      if (!oneOf(VOTE_STEPS, d.step)) problems.push(`${label}: step must be one of ${join(VOTE_STEPS)}`);
      else if ((d.counted === true) !== (d.step !== "uncounted")) problems.push(`${label}: step is uncounted exactly when counted is false`);
      if (d.counted === false ? !oneOf(NOT_COUNTED_REASONS, d.not_counted_reason) : "not_counted_reason" in d) {
        problems.push(`${label}: not_counted_reason (${join(NOT_COUNTED_REASONS)}) comes exactly with counted: false`);
      }
    } else {
      for (const key of ["counted", "step", "not_counted_reason"]) if (key in d) problems.push(`${label}: ${key} is a ${DECISIONS_SCHEMA_V14} field`);
    }
    const typedLine = v13 && d.kind === "type";
    const pass2 = v12 && d.pass === 2;
    if (v12 && (pass2 ? typeof d.same_reviewer !== "boolean" : "same_reviewer" in d)) problems.push(`${label}: same_reviewer is a boolean on pass-2 decisions only`);
    if (!nonEmpty(d.decision_id)) problems.push(`${label}: decision_id must be a non-empty string`);
    else if (ids.has(d.decision_id)) problems.push(`${label}: decision_id listed twice`);
    else if (
      typeof d.item_id === "string" &&
      typeof d.reviewer === "string" &&
      d.decision_id !== decisionId(pass2 ? `${d.item_id}${PASS2_SUFFIX}` : d.item_id, d.reviewer)
    ) {
      problems.push(`${label}: decision_id must be decision:<item_id>${pass2 ? PASS2_SUFFIX : ""}:<reviewer>`);
    }
    ids.add(d.decision_id);
    const key = `${String(d.item_id)}\u0000${String(d.reviewer)}\u0000${pass2 ? 2 : 1}`;
    if (item && decided.has(key)) problems.push(`${label}: a second decision by ${String(d.reviewer)} for ${item.item_id}; one per reviewer and pass`);
    decided.add(key);
    if (typedLine) {
      if (!oneOf(TYPE_DECISION_VALUES, d.decision)) problems.push(`${label}: a typed line's decision must be one of ${join(TYPE_DECISION_VALUES)}`);
      else if (d.decision === "typed" || d.decision === "pointed_print") {
        const textProblems = lineTextProblems(d.text);
        if (textProblems.length) problems.push(...textProblems.map((p) => `${label}: text ${p}`));
        else if (hasNiqqud(d.text as string)) problems.push(`${label}: typed text holds the letters only, without niqqud or marks`);
      } else if ("text" in d) problems.push(`${label}: only a typed or pointed_print decision carries text`);
      if ((d.decision === "not_on_page") !== oneOf(BOX_REASONS, d.box_reason)) problems.push(`${label}: box_reason (${join(BOX_REASONS)}) comes exactly with not_on_page`);
      // A drafted line's pass-1 decisions say which draft was shown (pre-fill amendment 1); any other typed line has none.
      const drafted = !pass2 && item?.prefill_provenance !== undefined;
      if (drafted) {
        if (d.candidate_sha256 !== item!.candidate_sha256) problems.push(`${label}: candidate_sha256 must be the sha256 of the draft shown`);
        if (d.prefill_provenance !== item!.prefill_provenance) problems.push(`${label}: prefill_provenance must be the draft's provenance`);
      } else {
        if ("candidate_sha256" in d) problems.push(`${label}: a typed line without a draft has no candidate_sha256`);
        if ("prefill_provenance" in d) problems.push(`${label}: a typed line without a draft has no prefill_provenance`);
      }
    } else if ("prefill_provenance" in d) {
      problems.push(`${label}: prefill_provenance is for typed lines only`);
    } else if (v13 && "box_reason" in d) {
      problems.push(`${label}: box_reason is for typed lines only`);
    }
    if (typedLine) {
      // checked above
    } else if (pass2) {
      if (!oneOf(PASS2_DECISION_VALUES, d.decision)) problems.push(`${label}: a pass-2 decision must be one of ${join(PASS2_DECISION_VALUES)}`);
      else if (d.decision === "typed" || d.decision === "pointed_print") {
        const textProblems = lineTextProblems(d.text);
        if (textProblems.length) problems.push(...textProblems.map((p) => `${label}: text ${p}`));
        else if (hasNiqqud(d.text as string)) problems.push(`${label}: typed text holds the letters only, without niqqud or marks`);
      } else if ("text" in d) problems.push(`${label}: only a typed or pointed_print decision carries text`);
    } else if (!oneOf(allowed, d.decision)) {
      problems.push(`${label}: decision must be one of ${join(allowed)} in ${String(payload.schema_version)}`);
    } else if (v13 && d.decision === "misaligned" && !pass2) {
      // v1.3 verify lines: misaligned carries the line as typed (letters only), scored like a typed line.
      const textProblems = lineTextProblems(d.text);
      if (textProblems.length) problems.push(...textProblems.map((p) => `${label}: a misaligned line's text ${p}`));
      else if (hasNiqqud(d.text as string)) problems.push(`${label}: typed text holds the letters only, without niqqud or marks`);
    } else if (d.decision === "edited") {
      const textProblems = lineTextProblems(d.text);
      if (textProblems.length) problems.push(...textProblems.map((p) => `${label}: text ${p}`));
      else if (item && d.text === item.candidate_text) problems.push(`${label}: an edit equal to the candidate is exact; record exact`);
    } else if (d.decision === "pointed_print" && "text" in d) {
      const textProblems = lineTextProblems(d.text);
      if (textProblems.length) problems.push(...textProblems.map((p) => `${label}: text ${p}`));
      else if (hasNiqqud(d.text as string)) problems.push(`${label}: a pointed_print text holds the letters only, without niqqud or marks`);
      else if (item && d.text === item.candidate_text) problems.push(`${label}: a pointed_print text equal to the candidate is recorded without text`);
    } else if ("text" in d) problems.push(`${label}: only an edited or pointed_print decision carries text`);
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
