/**
 * The volunteer line review contract between heocr-eval and HeOCR Review (2026-11-18). In: eval's registered files
 * from heocr-restricted-eval preregistration/midcentury_volunteers_2026-11-18/ (line_items_v1.json, the exclusions,
 * later gold_v1.json) with the batch's ai_flags.json and the record of pages the maintainer had decided at import.
 * Out: `line_consensus_decisions.v0`, which eval's ingest recomputes with agreement.py (§9 of the amendment).
 */
import { reviewerIdProblems } from "../reference_audit/schema";
import { LINE_ACTIONS, TEXT_ACTIONS, type LineAction } from "./consensus";

export const LINE_ITEMS_SCHEMA = "midcentury_line_items.v1";
export const EXCLUSIONS_SCHEMA = "midcentury_volunteer_exclusions.v1";
export const MAINTAINER_DECIDED_SCHEMA = "midcentury_maintainer_decided.v1";
export const GOLD_SCHEMA = "midcentury_gold.v1";
export const AI_FLAGS_SCHEMA = "heocr_midcentury_ai_flags.v0";
export const DECISIONS_SCHEMA = "line_consensus_decisions.v0";

export const LINE_ITEMS_FILE = "line_items_v1.json";
export const EXCLUSIONS_FILE = "volunteer_exclusions_v1.json";
export const MAINTAINER_FILE = "maintainer_decided.json";
export const GOLD_FILE = "gold_v1.json";
export const AI_FILE = "ai_flags.json";

/**
 * eval's files as registered (SHA256SUMS of the amendment folder, heocr-restricted-eval#29). The import refuses any
 * other content: they change only through a new registered file. gold_v1.json is added when eval registers it.
 */
export const REGISTERED_SHA256: Record<string, string> = {
  [LINE_ITEMS_FILE]: "ea25f3993cd3ec7cc004d353a890783d9747425c1b64efc417b0dcec31d393eb",
  [EXCLUSIONS_FILE]: "ad7be3b6b18df2720e9a8a197194e79df1e3343375aa7f7e4d48131d7220238c",
};
/** eval's agreement.py, which src/tasks/line_consensus/consensus.ts ports (named in every export). */
export const AGREEMENT_PY_SHA256 = "b0c1bb65397186c57457e2677b06bc92d6696e2af929a436ef408115065d40f7";
/** Batch manifest v1, which the line items and the hints were made from. */
export const BATCH_MANIFEST_SHA256 = "a6ac294f10f53d2dc9fcf17ff2ecc9217c3b96e57238b051de666072a17b767a";
/** The volunteer batch. */
export const VOLUNTEER_BATCH_ID = "newprinted_midcentury_volunteers_v0";
/** The maintainer's batch, whose decided pages are kept out at import. */
export const MAINTAINER_BATCH_ID = "newprinted_midcentury_v0";

export const BOX_STATUSES = ["matched", "fuzzy", "blank", "no_match"] as const;
/** Lines with a box a volunteer can be shown; no_match goes to the maintainer, blank is not reviewed. */
export const SHOWN_STATUSES = ["matched", "fuzzy"] as const;
export const PLANTED_KINDS = ["digit_swap", "mirrored_bracket", "letter_swap", "dropped_geresh", "merged_word"] as const;

export type PixelBox = [number, number, number, number];

export interface LineItem {
  i: number;
  prefill: string;
  box: PixelBox | null;
  box_status: (typeof BOX_STATUSES)[number];
  match: number | null;
  tier_a: boolean | null;
  bidi_risk: boolean | null;
}

export interface LinePage {
  page_key: string;
  image: string;
  image_sha256: string;
  image_size: [number, number];
  prefill_source: string;
  prefill_from_stock: boolean;
  lines: LineItem[];
}

export interface LineItemsFile {
  schema: typeof LINE_ITEMS_SCHEMA;
  batch_manifest_sha256: string;
  pages: LinePage[];
}

export interface ExclusionsFile {
  schema: typeof EXCLUSIONS_SCHEMA;
  batch_manifest_sha256: string;
  pages: { page_key: string; reason: string }[] | string[];
}

/** Written by scripts/maintainer-decided.ts from a read-only export of the maintainer's batch. */
export interface MaintainerDecidedFile {
  schema: typeof MAINTAINER_DECIDED_SCHEMA;
  batch_id: string;
  exported_at: string;
  pages: string[];
}

export interface GoldLine {
  gold_id: string;
  page_key: string;
  i: number;
  box: PixelBox;
  image_sha256: string;
  prefill_shown: string;
  planted_error: null | { kind: string; from: string; to: string };
  answer: { action: LineAction; text?: string | null };
}

export interface GoldFile {
  schema: typeof GOLD_SCHEMA;
  lines: GoldLine[];
}

export interface AiFlagsFile {
  schema: typeof AI_FLAGS_SCHEMA;
  manifest_sha256: string;
  pages: { unit_id: string; page: number; flagged_i: number[]; missing_near_i: number[] }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** A page key of batch manifest v1: `<unit_id>#p<page>`. */
const PAGE_KEY = /^[a-z_]+:[A-Za-z0-9_]+#p\d+$/;
const IMAGE = /^[A-Za-z0-9._/-]+\.(?:png|jpg|jpeg|webp)$/;

function boxProblems(at: string, box: unknown, size: [number, number] | null): string[] {
  if (!(Array.isArray(box) && box.length === 4 && box.every(isNum))) return [`${at}: box must be [x0, y0, x1, y1] in image pixels`];
  const [x0, y0, x1, y1] = box as PixelBox;
  if (!(0 <= x0 && x0 < x1 && 0 <= y0 && y0 < y1)) return [`${at}: box must have 0 <= x0 < x1 and 0 <= y0 < y1`];
  if (size && (x1 > size[0] || y1 > size[1])) return [`${at}: box must lie inside the image (${size[0]} x ${size[1]})`];
  return [];
}

export function lineItemsProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ["line_items_v1.json must be a JSON object"];
  if (raw.schema !== LINE_ITEMS_SCHEMA) return [`schema must be ${LINE_ITEMS_SCHEMA}`];
  if (raw.batch_manifest_sha256 !== BATCH_MANIFEST_SHA256) return [`batch_manifest_sha256 must be batch manifest v1's (${BATCH_MANIFEST_SHA256})`];
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) return ["pages must be a non-empty list"];
  const out: string[] = [];
  const keys = new Set<string>();
  for (const [k, p] of raw.pages.entries()) {
    const at = `pages[${k}]`;
    if (!isObj(p) || !isStr(p.page_key) || !PAGE_KEY.test(p.page_key)) {
      out.push(`${at}: page_key must be <unit_id>#p<page>`);
      continue;
    }
    if (keys.has(p.page_key)) out.push(`${p.page_key}: listed twice`);
    keys.add(p.page_key);
    if (!(isStr(p.image) && IMAGE.test(p.image))) out.push(`${p.page_key}: image must be a plain image path`);
    if (!(isStr(p.image_sha256) && HEX64.test(p.image_sha256))) out.push(`${p.page_key}: image_sha256 must be a sha256`);
    const size = Array.isArray(p.image_size) && p.image_size.length === 2 && p.image_size.every((v) => isInt(v) && v > 0) ? (p.image_size as [number, number]) : null;
    if (!size) out.push(`${p.page_key}: image_size must be [width, height]`);
    if (!isStr(p.prefill_source)) out.push(`${p.page_key}: prefill_source must name the registered source`);
    if (typeof p.prefill_from_stock !== "boolean") out.push(`${p.page_key}: prefill_from_stock must be a boolean`);
    if (!Array.isArray(p.lines)) {
      out.push(`${p.page_key}: lines must be a list`);
      continue;
    }
    const seen = new Set<number>();
    for (const l of p.lines as unknown[]) {
      const lat = `${p.page_key} line ${isObj(l) ? String(l.i) : "?"}`;
      if (!isObj(l) || !isInt(l.i) || l.i < 0 || seen.has(l.i)) {
        out.push(`${lat}: i must be a distinct line index`);
        continue;
      }
      seen.add(l.i);
      if (!oneOf(BOX_STATUSES, l.box_status)) out.push(`${lat}: box_status must be one of ${BOX_STATUSES.join(", ")}`);
      if (typeof l.prefill !== "string") out.push(`${lat}: prefill must be a string`);
      else if (l.box_status !== "blank" && l.prefill.trim() === "") out.push(`${lat}: a non-blank status needs a pre-fill line`);
      if (oneOf(SHOWN_STATUSES, l.box_status)) out.push(...boxProblems(lat, l.box, size));
      else if (l.box !== null && l.box !== undefined) out.push(`${lat}: a ${String(l.box_status)} line has no box`);
      // null: the line has no flags entry (fewer than 4 Hebrew letters); the import applies the page review's rule.
      if (!(l.tier_a === null || typeof l.tier_a === "boolean") || !(l.bidi_risk === null || typeof l.bidi_risk === "boolean")) out.push(`${lat}: tier_a and bidi_risk must be booleans or null`);
      if (!(l.match === null || isNum(l.match))) out.push(`${lat}: match must be a number or null`);
    }
  }
  return out;
}

/** The page keys never shown to volunteers. */
export function exclusionKeys(raw: ExclusionsFile): Set<string> {
  return new Set((raw.pages as unknown[]).map((p) => (typeof p === "string" ? p : (p as { page_key: string }).page_key)));
}

export function exclusionsProblems(raw: unknown): string[] {
  if (!isObj(raw)) return [`${EXCLUSIONS_FILE} must be a JSON object`];
  if (raw.schema !== EXCLUSIONS_SCHEMA) return [`${EXCLUSIONS_FILE}: schema must be ${EXCLUSIONS_SCHEMA}`];
  if (raw.batch_manifest_sha256 !== BATCH_MANIFEST_SHA256) return [`${EXCLUSIONS_FILE}: batch_manifest_sha256 must be batch manifest v1's`];
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) return [`${EXCLUSIONS_FILE}: pages must be a non-empty list`];
  const bad = (raw.pages as unknown[]).filter((p) => !(isStr(p) || (isObj(p) && isStr(p.page_key))));
  return bad.length ? [`${EXCLUSIONS_FILE}: every page must be a page key`] : [];
}

export function maintainerDecidedProblems(raw: unknown): string[] {
  if (!isObj(raw)) return [`${MAINTAINER_FILE} must be a JSON object`];
  if (raw.schema !== MAINTAINER_DECIDED_SCHEMA) return [`${MAINTAINER_FILE}: schema must be ${MAINTAINER_DECIDED_SCHEMA}`];
  const out: string[] = [];
  if (raw.batch_id !== MAINTAINER_BATCH_ID) out.push(`${MAINTAINER_FILE}: batch_id must be ${MAINTAINER_BATCH_ID}`);
  if (!(isStr(raw.exported_at) && ISO.test(raw.exported_at))) out.push(`${MAINTAINER_FILE}: exported_at must be the export's ISO UTC timestamp`);
  if (!(Array.isArray(raw.pages) && raw.pages.every((p) => isStr(p) && PAGE_KEY.test(p)))) out.push(`${MAINTAINER_FILE}: pages must be a list of page keys`);
  return out;
}

export function goldProblems(raw: unknown, pages: Map<string, LinePage>, queued: Set<string>): string[] {
  if (!isObj(raw)) return [`${GOLD_FILE} must be a JSON object`];
  if (raw.schema !== GOLD_SCHEMA) return [`${GOLD_FILE}: schema must be ${GOLD_SCHEMA}`];
  if (!Array.isArray(raw.lines)) return [`${GOLD_FILE}: lines must be a list`];
  const out: string[] = [];
  const ids = new Set<string>();
  const at = new Set<string>();
  for (const [k, g] of raw.lines.entries()) {
    const lat = `${GOLD_FILE} lines[${k}]`;
    if (!isObj(g) || !isStr(g.gold_id) || !isStr(g.page_key) || !isInt(g.i)) {
      out.push(`${lat}: needs gold_id, page_key and i`);
      continue;
    }
    if (ids.has(g.gold_id)) out.push(`${lat}: gold_id ${g.gold_id} repeats`);
    ids.add(g.gold_id);
    const where = `${g.page_key}#l${g.i}`;
    if (at.has(where)) out.push(`${lat}: ${where} is gold twice`);
    at.add(where);
    // A gold line's page is never queued: its answer would otherwise also be a volunteer reference.
    if (queued.has(g.page_key)) out.push(`${lat}: ${g.page_key} is a volunteer page; gold comes from pages volunteers are never given`);
    const page = pages.get(g.page_key);
    if (!page) out.push(`${lat}: ${g.page_key} is not in ${LINE_ITEMS_FILE}`);
    else if (g.image_sha256 !== page.image_sha256) out.push(`${lat}: image_sha256 is not the page's`);
    out.push(...boxProblems(lat, g.box, page ? page.image_size : null));
    if (typeof g.prefill_shown !== "string" || g.prefill_shown.trim() === "") out.push(`${lat}: prefill_shown must be the line shown`);
    if (!(g.planted_error === null || (isObj(g.planted_error) && isStr(g.planted_error.kind)))) out.push(`${lat}: planted_error must be null or {kind, from, to}`);
    const a = g.answer;
    if (!(isObj(a) && oneOf(LINE_ACTIONS, a.action))) out.push(`${lat}: answer.action must be one of ${LINE_ACTIONS.join(", ")}`);
    else if ((a.action === "correct" || TEXT_ACTIONS.includes(a.action)) && typeof a.text !== "string") out.push(`${lat}: answer.text must be the reference text`);
  }
  return out;
}

export function aiFlagsProblems(raw: unknown): string[] {
  if (!isObj(raw)) return [`${AI_FILE} must be a JSON object`];
  if (raw.schema !== AI_FLAGS_SCHEMA) return [`${AI_FILE}: schema must be ${AI_FLAGS_SCHEMA}`];
  if (raw.manifest_sha256 !== BATCH_MANIFEST_SHA256) return [`${AI_FILE}: manifest_sha256 must be batch manifest v1's`];
  if (!Array.isArray(raw.pages)) return [`${AI_FILE}: pages must be a list`];
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// The decisions file (line_consensus_decisions.v0)

export const ROLES = ["first", "second", "third", "extra", "maintainer", "gold"] as const;
export const NOT_COUNTED = ["fewer_than_20_gold", "below_floor", "excluded_by_admin", "gold_line", "maintainer"] as const;
export const OUTCOMES = ["agreed", "majority", "to_maintainer", "maintainer", "pending"] as const;

export interface ExportDecision {
  decision_id: string;
  reviewer: string;
  page_key: string;
  i: number;
  action: LineAction;
  /** The final text: the pre-fill shown for correct, the volunteer's for edit and print_has_niqqud, else null. */
  text: string | null;
  decided_at: string;
  role: (typeof ROLES)[number];
  flags_shown: { tier_a: boolean; ai_flagged: boolean | null; ai_missing_near: boolean | null };
  gold_id: string | null;
  /** For a gold line: whether the decision agrees with the gold answer (agreement.gold_hit). */
  gold_hit: boolean | null;
  counted: boolean;
  not_counted_reason: (typeof NOT_COUNTED)[number] | null;
}

export interface ExportLine {
  page_key: string;
  i: number;
  prefill: string;
  box_status: string;
  outcome: (typeof OUTCOMES)[number];
  /** The reference: action and final text of the agreeing (or the maintainer's) decision; null while pending. */
  reference: { action: LineAction; text: string | null } | null;
  decision_ids: string[];
}

export interface ExportReviewer {
  reviewer: string;
  gold_seen: number;
  gold_hits: number;
  planted_seen: number;
  planted_hits: number;
  standing: "counting" | "provisional" | "below_floor" | "excluded";
  decisions: number;
  decisions_counted: number;
}

export interface DecisionsFile {
  schema_version: typeof DECISIONS_SCHEMA;
  batch_id: string;
  exported_at: string;
  sources: Record<string, string | null>;
  maintainer_decided_excluded: { exported_at: string; pages: string[] };
  rule: { floor: number; min_gold: number; agreement: string };
  decisions: ExportDecision[];
  lines: ExportLine[];
  reviewers: ExportReviewer[];
  admin_exclusions: { reviewer: string; excluded_at: string }[];
}

export function decisionsFileProblems(raw: unknown, batchId: string, known: Set<string>): string[] {
  if (!isObj(raw)) return ["the decisions file must be a JSON object"];
  const out: string[] = [];
  if (raw.schema_version !== DECISIONS_SCHEMA) out.push(`schema_version must be ${DECISIONS_SCHEMA}`);
  if (raw.batch_id !== batchId) out.push(`batch_id must be ${batchId}`);
  if (!Array.isArray(raw.decisions) || !Array.isArray(raw.lines) || !Array.isArray(raw.reviewers)) return [...out, "decisions, lines and reviewers must be lists"];
  const ids = new Set<string>();
  for (const [k, d] of (raw.decisions as Obj[]).entries()) {
    const at = `decisions[${k}]`;
    if (ids.has(String(d.decision_id))) out.push(`${at}: decision_id repeats`);
    ids.add(String(d.decision_id));
    out.push(...reviewerIdProblems(d.reviewer).map((p) => `${at}.reviewer ${p}`));
    if (!known.has(`${String(d.page_key)}#l${String(d.i)}`)) out.push(`${at}: not a line of this batch`);
    if (!oneOf(LINE_ACTIONS, d.action)) out.push(`${at}: action must be one of ${LINE_ACTIONS.join(", ")}`);
    else if ((d.action === "correct" || TEXT_ACTIONS.includes(d.action)) !== (typeof d.text === "string")) out.push(`${at}: text must be a string exactly for correct, edit and print_has_niqqud`);
    if (!oneOf(ROLES, d.role)) out.push(`${at}: role must be one of ${ROLES.join(", ")}`);
    if (typeof d.counted !== "boolean" || (d.counted ? d.not_counted_reason !== null : !oneOf(NOT_COUNTED, d.not_counted_reason))) out.push(`${at}: counted needs a reason exactly when false`);
    if ((d.role === "gold") !== (typeof d.gold_id === "string")) out.push(`${at}: gold_id is set exactly on gold decisions`);
    if (!(typeof d.decided_at === "string" && ISO.test(d.decided_at))) out.push(`${at}: decided_at must be an ISO UTC timestamp`);
  }
  for (const [k, l] of (raw.lines as Obj[]).entries()) {
    if (!oneOf(OUTCOMES, l.outcome)) out.push(`lines[${k}]: outcome must be one of ${OUTCOMES.join(", ")}`);
    if ((l.outcome === "pending" || l.outcome === "to_maintainer") !== (l.reference === null)) out.push(`lines[${k}]: reference is null exactly while pending or with the maintainer`);
    for (const id of Array.isArray(l.decision_ids) ? (l.decision_ids as string[]) : []) if (!ids.has(id)) out.push(`lines[${k}]: ${id} is not a decision in this file`);
  }
  return out;
}
