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
 */
import { pyLen, reviewerIdProblems, validDate } from "../reference_audit/schema";
import { hasNiqqud } from "../../shared/niqqud";
import { OPEN_LICENCE_PROBLEM, isOpenLicence } from "../../shared/licence";
import { MAX_TEXT_LENGTH } from "../types";

export const ITEMS_SCHEMA = "line_verify_items.v1";
export const ITEMS_SCHEMA_V11 = "line_verify_items.v1.1";
export const ITEMS_SCHEMAS = [ITEMS_SCHEMA, ITEMS_SCHEMA_V11] as const;
export const DECISIONS_SCHEMA = "line_verify_decisions.v1.1";
/** Decisions on a v1.1 batch: v1.1 plus `pass` on every decision. */
export const DECISIONS_SCHEMA_V12 = "line_verify_decisions.v1.2";
/** Every version validates; a v1 file may not use `pointed_print`, and only v1.2 carries `pass`. */
export const DECISIONS_SCHEMAS = ["line_verify_decisions.v1", DECISIONS_SCHEMA, DECISIONS_SCHEMA_V12] as const;
export const SOURCES = ["wikisource_he_proofread", "benyehuda_nli_aligned"] as const;
export const PROVENANCES = ["wikisource_quality3_single_proofreader", "pby_human_typed_aligned"] as const;
/** v1.1 adds edition texts: the candidate is a published edition's text, never OCR. */
export const SOURCES_V11 = [...SOURCES, "sefaria_edition", "gutenberg_edition", "benyehuda_text", "wikisource_he"] as const;
export const PROVENANCES_V11 = [
  ...PROVENANCES,
  "sefaria_exact_edition",
  "gutenberg_exact_edition",
  "pby_human_typed",
  "wikisource_quality4_validated",
  "wikisource_quality1_unproofread",
] as const;
/** The page's typeface (v1.1): Rashi script is its own stratum. */
export const SCRIPTS = ["square", "rashi"] as const;
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
  /** v1.1 only, and required there. */
  script?: (typeof SCRIPTS)[number];
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
  candidate_text: string;
  candidate_provenance: (typeof PROVENANCES_V11)[number];
  alignment_score: number;
  attention_spans: [number, number][];
  difficulty: number;
  stratum: (typeof STRATA)[number];
  rank: number;
  /** v1.1 only, optional. */
  precheck?: LvPrecheck;
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
  decision: (typeof DECISION_VALUES)[number] | (typeof PASS2_DECISION_VALUES)[number];
  text?: string;
  /** Additive to the v1 contract: SHA-256 of the UTF-8 candidate_text the reviewer judged (see README). */
  candidate_sha256?: string;
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

function pageProblems(page: Obj, v11: boolean): string[] {
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

function itemProblems(item: Obj, page: Obj | undefined, v11: boolean): string[] {
  const problems: string[] = [];
  if (typeof item.item_id === "string" && item.item_id.includes(PASS2_SUFFIX)) problems.push(`item_id must not contain ${PASS2_SUFFIX}`);
  if (!(isInt(item.line_index) && item.line_index >= 0)) problems.push("line_index must be a non-negative integer");
  problems.push(...pixelBoxProblems("box", item.box, page), ...pixelBoxProblems("context_box", item.context_box, page));
  problems.push(...lineTextProblems(item.candidate_text).map((p) => `candidate_text ${p}`));
  const provenances = v11 ? PROVENANCES_V11 : PROVENANCES;
  if (!oneOf(provenances, item.candidate_provenance)) problems.push(`candidate_provenance must be one of ${join(provenances)}`);
  if ("precheck" in item) {
    if (v11) problems.push(...precheckProblems(item.precheck));
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

/** Every problem with a line_verify_items.v1 or .v1.1 file (empty when valid). */
export function itemsFileProblems(payload: unknown): string[] {
  if (!isObj(payload) || !oneOf(ITEMS_SCHEMAS, payload.schema_version)) return [`schema_version must be one of ${join(ITEMS_SCHEMAS)}`];
  const v11 = payload.schema_version === ITEMS_SCHEMA_V11;
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
    problems.push(...pageProblems(page, v11).map((p) => `page ${id}: ${p}`));
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
    problems.push(...itemProblems(item, page, v11).map((p) => `item ${id}: ${p}`));
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
  candidate_text: string;
  candidate_sha256?: string;
  /** The line has a blind second pass (v1.2 decisions may then carry pass 2). */
  blind?: boolean;
}

/** Every problem with a line_verify_decisions.v1, .v1.1 or .v1.2 file, checked against its items. */
export function decisionsFileProblems(payload: unknown, batchId: string, items: ItemRef[]): string[] {
  if (!isObj(payload) || !oneOf(DECISIONS_SCHEMAS, payload.schema_version)) return [`schema_version must be one of ${join(DECISIONS_SCHEMAS)}`];
  const allowed: readonly string[] = payload.schema_version === "line_verify_decisions.v1" ? DECISION_VALUES_V1 : DECISION_VALUES;
  const v12 = payload.schema_version === DECISIONS_SCHEMA_V12;
  const problems: string[] = [];
  if (v12) {
    const mode = isObj(payload.pass2_reviewer) ? payload.pass2_reviewer : {};
    if (!oneOf(PASS2_REVIEWERS, mode.mode)) problems.push(`pass2_reviewer.mode must be one of ${join(PASS2_REVIEWERS)}`);
    if (!(mode.set_at === null || typeof mode.set_at === "string")) problems.push("pass2_reviewer.set_at must be a timestamp or null");
    const list = isObj(payload.blind_second_pass) ? payload.blind_second_pass : {};
    if (!(isInt(list.count) && list.count >= 0 && typeof list.sha256 === "string" && SHA256.test(list.sha256))) {
      problems.push("blind_second_pass must give the list's count and sha256");
    } else if (list.count !== items.filter((i) => i.blind).length) problems.push("blind_second_pass.count is not the number of blind lines");
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
    if (pass2) {
      if (!oneOf(PASS2_DECISION_VALUES, d.decision)) problems.push(`${label}: a pass-2 decision must be one of ${join(PASS2_DECISION_VALUES)}`);
      else if (d.decision === "typed" || d.decision === "pointed_print") {
        const textProblems = lineTextProblems(d.text);
        if (textProblems.length) problems.push(...textProblems.map((p) => `${label}: text ${p}`));
        else if (hasNiqqud(d.text as string)) problems.push(`${label}: typed text holds the letters only, without niqqud or marks`);
      } else if ("text" in d) problems.push(`${label}: only a typed or pointed_print decision carries text`);
    } else if (!oneOf(allowed, d.decision)) {
      problems.push(`${label}: decision must be one of ${join(allowed)} in ${String(payload.schema_version)}`);
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
