/**
 * The handwriting transcription contract (task type line_transcribe; heocr-eval's h_eval_v1, amendments 1 and 2).
 * In: the line boxes of the H eval pages, `h_line_items.v1` (bundle file h_line_items_v1.json with its pages/),
 * made by data-collection and registered by eval. Out: `h_line_transcriptions.v0`, from which eval's ingest
 * recomputes every outcome with agreement.py.
 *
 * DRAFT until eval registers the box file and the per-box rule (amendment 3): the import refuses any box file whose
 * sha256 is not in REGISTERED_SHA256, which is empty until then.
 */
import { reviewerIdProblems } from "../reference_audit/schema";
import { TEXT_ACTIONS } from "../line_consensus/consensus";
import { LANGUAGE_LABELS } from "../../shared/languages";

export { LANGUAGE_LABELS };

export const H_LINE_ITEMS_SCHEMA = "h_line_items.v1";
export const H_DECISIONS_SCHEMA = "h_line_transcriptions.v0";
export const H_LINE_ITEMS_FILE = "h_line_items_v1.json";

/** eval's registered box file(s). Empty until eval registers one: the import refuses every box file meanwhile. */
export const REGISTERED_SHA256: Record<string, string> = {};
/** The H manifests the box file is made from (h_eval_v1 README and amendment 2). */
export const H_MANIFESTS: Record<string, string> = {
  h_eval_v1: "63e9f31cfdd1987c17f02dbb5028ed9427a2e1d0993ac53625adb91226cbb642",
  h_eval_v1_1: "a1c7f6166eef0fcbbd17e9d5f35a510ff40cc31454e003db1c6d310703b2a153",
};
export const H_BATCH_ID = "h_eval_v1_transcribe_v0";
/**
 * Whose transcriptions count: volunteers counting in the mid-century volunteer batch (95% on at least 20 gold
 * lines). Anyone may transcribe; other decisions are kept and do not count (lead, 2026-11-18: a counting rule, not
 * an access gate). Handwriting gold comes with a later amendment.
 */
export const GATE_BATCH_ID = "newprinted_midcentury_volunteers_v0";

export const STRATA = ["primary", "seen_writer", "other_hebrew_script"] as const;
export type Stratum = (typeof STRATA)[number];
/** Only these strata are served to every gated volunteer; other_hebrew_script only to those who opt in to its languages. */
export const OPT_IN_STRATUM: Stratum = "other_hebrew_script";
/** One illegible span inside a line, whatever its length: a fixed token, so two transcriptions can agree (proposed). */
export const SPAN_MARKER = "[?]";

export type PixelBox = [number, number, number, number];

export interface HLine {
  i: number;
  box: PixelBox;
}

export interface HPage {
  /** The manifest's entry_id. */
  page_key: string;
  eval_set: keyof typeof H_MANIFESTS;
  stratum: Stratum;
  languages: string[];
  hand_id: string;
  attribution: string;
  license_expression: string;
  source_url: string;
  image: string;
  image_sha256: string;
  image_size: [number, number];
  /** Lines in reading order. */
  lines: HLine[];
}

export interface HLineItemsFile {
  schema: typeof H_LINE_ITEMS_SCHEMA;
  manifests: Record<string, string>;
  pages: HPage[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** A HASH entry id: `<provider>__<unit>__p<page>`. */
const PAGE_KEY = /^[a-z]+__[A-Za-z0-9_]+__p\d{4}$/;
const IMAGE = /^[A-Za-z0-9._/-]+\.(?:png|jpg|jpeg|webp)$/;
const LANG = /^[a-z]{2,3}$/;

function boxProblems(at: string, box: unknown, size: [number, number] | null): string[] {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(isInt)) return [`${at} must be [x0, y0, x1, y1] in whole pixels`];
  const [x0, y0, x1, y1] = box as PixelBox;
  if (!(x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0)) return [`${at} must have x0 < x1 and y0 < y1, all non-negative`];
  if (size && (x1 > size[0] || y1 > size[1])) return [`${at} must lie inside the page image (${size[0]}x${size[1]})`];
  return [];
}

export function hLineItemsProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ["the box file must be a JSON object"];
  const out: string[] = [];
  if (raw.schema !== H_LINE_ITEMS_SCHEMA) out.push(`schema must be ${H_LINE_ITEMS_SCHEMA}`);
  if (!isObj(raw.manifests)) out.push("manifests must map each eval set to its manifest sha256");
  else {
    for (const [k, v] of Object.entries(raw.manifests)) {
      if (H_MANIFESTS[k] === undefined) out.push(`manifests.${k} is not an H eval set`);
      else if (v !== H_MANIFESTS[k]) out.push(`manifests.${k} must be the registered manifest ${H_MANIFESTS[k]}`);
    }
  }
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) return [...out, "pages must be a non-empty array"];
  const seen = new Set<string>();
  raw.pages.forEach((p: unknown, k: number) => {
    const at = `pages[${k}]`;
    if (!isObj(p)) return void out.push(`${at} must be an object`);
    if (typeof p.page_key !== "string" || !PAGE_KEY.test(p.page_key)) out.push(`${at}.page_key must be a HASH entry id`);
    else if (seen.has(p.page_key)) out.push(`${at}.page_key ${p.page_key} is repeated`);
    else seen.add(p.page_key);
    if (!(typeof p.eval_set === "string" && H_MANIFESTS[p.eval_set] !== undefined)) out.push(`${at}.eval_set must be one of ${Object.keys(H_MANIFESTS).join(", ")}`);
    else if (isObj(raw.manifests) && raw.manifests[p.eval_set] === undefined) out.push(`${at}.eval_set ${p.eval_set} is not in manifests`);
    if (!oneOf(STRATA, p.stratum)) out.push(`${at}.stratum must be one of ${STRATA.join(", ")}`);
    if (!Array.isArray(p.languages) || p.languages.length === 0 || !p.languages.every((l) => typeof l === "string" && LANG.test(l))) {
      out.push(`${at}.languages must be a non-empty list of language codes`);
    } else if (p.stratum === OPT_IN_STRATUM && !p.languages.some((l) => l !== "he")) {
      out.push(`${at} is ${OPT_IN_STRATUM} but lists no language besides he`);
    } else if (p.stratum === OPT_IN_STRATUM && p.languages.some((l) => l !== "he" && LANGUAGE_LABELS[l as string] === undefined)) {
      out.push(`${at}.languages has a code the app has no label for`);
    }
    for (const f of ["hand_id", "attribution", "license_expression", "source_url"]) if (!isStr(p[f])) out.push(`${at}.${f} must be a non-empty string`);
    if (typeof p.image !== "string" || !IMAGE.test(p.image)) out.push(`${at}.image must be a plain image path`);
    if (typeof p.image_sha256 !== "string" || !HEX64.test(p.image_sha256)) out.push(`${at}.image_sha256 must be a sha256`);
    const size = Array.isArray(p.image_size) && p.image_size.length === 2 && p.image_size.every((n) => isInt(n) && n > 0) ? (p.image_size as [number, number]) : null;
    if (!size) out.push(`${at}.image_size must be [width, height] in pixels`);
    if (!Array.isArray(p.lines) || p.lines.length === 0) return void out.push(`${at}.lines must be a non-empty array`);
    const is = new Set<number>();
    p.lines.forEach((l: unknown, j: number) => {
      const lat = `${at}.lines[${j}]`;
      if (!isObj(l)) return void out.push(`${lat} must be an object`);
      if (!(isInt(l.i) && l.i >= 0)) out.push(`${lat}.i must be a non-negative integer`);
      else if (is.has(l.i)) out.push(`${lat}.i ${l.i} is repeated`);
      else is.add(l.i);
      out.push(...boxProblems(`${lat}.box`, l.box, size));
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The export: h_line_transcriptions.v0

export const H_ACTIONS = ["edit", "print_has_niqqud", "unreadable", "not_on_page"] as const;
export type HAction = (typeof H_ACTIONS)[number];
export const H_ROLES = ["first", "second", "third", "extra", "maintainer"] as const;
export const H_NOT_COUNTED = ["fewer_than_20_gold", "below_floor", "excluded_by_admin", "maintainer"] as const;
export const H_OUTCOMES = ["agreed", "majority", "to_maintainer", "maintainer", "pending"] as const;

export interface HExportDecision {
  decision_id: string;
  reviewer: string;
  page_key: string;
  i: number;
  action: HAction;
  text: string | null;
  decided_at: string;
  role: (typeof H_ROLES)[number];
  counted: boolean;
  not_counted_reason: (typeof H_NOT_COUNTED)[number] | null;
}

export interface HExportLine {
  page_key: string;
  i: number;
  eval_set: string;
  stratum: Stratum;
  languages: string[];
  hand_id: string;
  outcome: (typeof H_OUTCOMES)[number];
  reference: null | { action: HAction; text: string | null };
  decision_ids: string[];
}

export interface HExportReviewer {
  reviewer: string;
  /** Their standing in the gate batch at export (what decides whether their transcriptions count). */
  standing: string;
  decisions: number;
  decisions_counted: number;
}

export interface HDecisionsFile {
  schema_version: typeof H_DECISIONS_SCHEMA;
  batch_id: string;
  exported_at: string;
  sources: Record<string, string | null>;
  rule: { gate_batch: string; floor: number; min_gold: number; agreement: string; span_marker: string };
  /** Lines per stratum and outcome: the strata are kept apart. */
  strata: Record<string, Record<string, number>>;
  decisions: HExportDecision[];
  lines: HExportLine[];
  reviewers: HExportReviewer[];
  admin_exclusions: { reviewer: string; excluded_at: string }[];
}

export function hDecisionsFileProblems(raw: unknown, batchId: string, known: Set<string>): string[] {
  if (!isObj(raw)) return ["the export must be a JSON object"];
  const out: string[] = [];
  if (raw.schema_version !== H_DECISIONS_SCHEMA) out.push(`schema_version must be ${H_DECISIONS_SCHEMA}`);
  if (raw.batch_id !== batchId) out.push(`batch_id must be ${batchId}`);
  if (typeof raw.exported_at !== "string" || !ISO.test(raw.exported_at)) out.push("exported_at must be an ISO time");
  if (!Array.isArray(raw.decisions) || !Array.isArray(raw.lines) || !Array.isArray(raw.reviewers)) return [...out, "decisions, lines and reviewers must be arrays"];
  const ids = new Set<string>();
  raw.decisions.forEach((d: unknown, k: number) => {
    const at = `decisions[${k}]`;
    if (!isObj(d)) return void out.push(`${at} must be an object`);
    if (!isStr(d.decision_id) || ids.has(d.decision_id)) out.push(`${at}.decision_id must be unique`);
    else ids.add(d.decision_id);
    out.push(...reviewerIdProblems(d.reviewer).map((m) => `${at}.reviewer ${m}`));
    if (!known.has(`${String(d.page_key)}#l${String(d.i)}`)) out.push(`${at} is not a line of this batch`);
    if (!oneOf(H_ACTIONS, d.action)) out.push(`${at}.action must be one of ${H_ACTIONS.join(", ")}`);
    else if ((TEXT_ACTIONS as readonly string[]).includes(d.action) !== (typeof d.text === "string")) out.push(`${at}.text must be given exactly for edit and print_has_niqqud`);
    if (!oneOf(H_ROLES, d.role)) out.push(`${at}.role must be one of ${H_ROLES.join(", ")}`);
    if (typeof d.counted !== "boolean") out.push(`${at}.counted must be a boolean`);
    else if (d.counted !== (d.not_counted_reason === null)) out.push(`${at}.not_counted_reason must be null exactly when counted`);
  });
  raw.lines.forEach((l: unknown, k: number) => {
    const at = `lines[${k}]`;
    if (!isObj(l)) return void out.push(`${at} must be an object`);
    if (!known.has(`${String(l.page_key)}#l${String(l.i)}`)) out.push(`${at} is not a line of this batch`);
    if (!oneOf(STRATA, l.stratum)) out.push(`${at}.stratum must be one of ${STRATA.join(", ")}`);
    if (!oneOf(H_OUTCOMES, l.outcome)) out.push(`${at}.outcome must be one of ${H_OUTCOMES.join(", ")}`);
    if (!Array.isArray(l.decision_ids) || !l.decision_ids.every((x) => typeof x === "string" && ids.has(x))) out.push(`${at}.decision_ids must name decisions of this file`);
  });
  return out;
}
