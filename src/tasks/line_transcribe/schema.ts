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
 * The first contribution terms whose scope covers typing text from handwritten pages (drafted separately, held for
 * the maintainer). Until a volunteer has accepted these or later terms, this task is listed and served to the
 * maintainer only: a matter of the terms, not of accuracy (lead, 2026-11-18).
 */
export const TRANSCRIBE_TERMS_VERSION = "2026-11-18-v1";

/** Whether accepted terms `accepted` cover transcription (versions are date-ordered strings). */
export function termsCoverTranscription(accepted: string | null, required: string = TRANSCRIBE_TERMS_VERSION): boolean {
  return accepted !== null && accepted >= required;
}
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

/** The registered manifests, as sidecars in the bundle (paths as in HASH data/eval/), by eval set. */
export const MANIFEST_FILES: Record<string, string> = {
  h_eval_v1: "h_eval_v1/manifest.jsonl",
  h_eval_v1_1: "h_eval_v1_1/manifest.jsonl",
};
/** Page flags in the box file. no_hebrew_text pages stay out of the queue until eval rules on them (amendment 3). */
export const PAGE_FLAGS = ["poor", "no_hebrew_text"] as const;
export const HELD_PAGE_FLAG = "no_hebrew_text";

export interface HLine {
  i: number;
  prefill: "";
  box: PixelBox;
  box_status: string;
}

/** A page of the box file (data-collection's h_line_items.v1, shaped after eval's midcentury_line_items.v1). */
export interface HPage {
  /** The manifest's entry_id. */
  page_key: string;
  eval_set: string;
  stratum: Stratum;
  source_id: string;
  /** The image's path in HASH; the bundle holds it at the same path. */
  image: string;
  image_sha256: string;
  /** [width, height] in the displayed frame (EXIF orientation applied). */
  image_size: [number, number];
  exif_orientation: number;
  coordinate_frame: "display";
  segmenter: string;
  page_flag: (typeof PAGE_FLAGS)[number] | null;
  /** Lines in reading order. */
  lines: HLine[];
}

export interface HLineItemsFile {
  schema: typeof H_LINE_ITEMS_SCHEMA;
  manifest_sha256: Record<string, string>;
  pages: HPage[];
}

/** The fields of a manifest row the import uses. */
export interface HManifestRow {
  entry_id: string;
  stratum: string;
  image_sha256: string;
  languages: string[];
  provider: string;
  holding_institution: string | null;
  license_expression: string;
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

/** The manifest rows by entry id, from the sidecars (each a list of rows), per eval set. */
export function manifestIndex(sidecars: Record<string, unknown> | undefined): Map<string, HManifestRow & { eval_set: string }> {
  const out = new Map<string, HManifestRow & { eval_set: string }>();
  for (const [set, file] of Object.entries(MANIFEST_FILES)) {
    const rows = sidecars?.[file];
    if (!Array.isArray(rows)) continue;
    for (const r of rows) if (isObj(r) && typeof r.entry_id === "string") out.set(r.entry_id, { ...(r as unknown as HManifestRow), eval_set: set });
  }
  return out;
}

function manifestRowProblems(at: string, r: HManifestRow): string[] {
  const out: string[] = [];
  if (!Array.isArray(r.languages) || r.languages.length === 0 || !r.languages.every((l) => typeof l === "string" && LANG.test(l))) {
    out.push(`${at}: the manifest's languages must be a non-empty list of language codes`);
  } else if (r.stratum === OPT_IN_STRATUM && !r.languages.some((l) => l !== "he")) {
    out.push(`${at} is ${OPT_IN_STRATUM} but its manifest lists no language besides he`);
  } else if (r.stratum === OPT_IN_STRATUM && r.languages.some((l) => l !== "he" && LANGUAGE_LABELS[l] === undefined)) {
    out.push(`${at}: the manifest has a language code the app has no label for`);
  }
  if (!isStr(r.provider)) out.push(`${at}: the manifest names no provider`);
  if (!isStr(r.license_expression)) out.push(`${at}: the manifest has no licence`);
  return out;
}

/** Problems with the box file, read against the registered manifests (sidecars MANIFEST_FILES). */
export function hLineItemsProblems(raw: unknown, sidecars?: Record<string, unknown>): string[] {
  if (!isObj(raw)) return ["the box file must be a JSON object"];
  const out: string[] = [];
  if (raw.schema !== H_LINE_ITEMS_SCHEMA) out.push(`schema must be ${H_LINE_ITEMS_SCHEMA}`);
  if (!isObj(raw.manifest_sha256)) out.push("manifest_sha256 must map each eval set to its manifest sha256");
  else {
    for (const [k, v] of Object.entries(raw.manifest_sha256)) {
      if (H_MANIFESTS[k] === undefined) out.push(`manifest_sha256.${k} is not an H eval set`);
      else if (v !== H_MANIFESTS[k]) out.push(`manifest_sha256.${k} must be the registered manifest ${H_MANIFESTS[k]}`);
    }
  }
  for (const [set, file] of Object.entries(MANIFEST_FILES)) if (!Array.isArray(sidecars?.[file])) out.push(`the bundle must hold ${file} (the registered ${set} manifest)`);
  const manifest = manifestIndex(sidecars);
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) return [...out, "pages must be a non-empty array"];
  const seen = new Set<string>();
  raw.pages.forEach((p: unknown, k: number) => {
    const at = `pages[${k}]`;
    if (!isObj(p)) return void out.push(`${at} must be an object`);
    if (typeof p.page_key !== "string" || !PAGE_KEY.test(p.page_key)) out.push(`${at}.page_key must be a HASH entry id`);
    else if (seen.has(p.page_key)) out.push(`${at}.page_key ${p.page_key} is repeated`);
    else seen.add(p.page_key);
    if (!(typeof p.eval_set === "string" && H_MANIFESTS[p.eval_set] !== undefined)) out.push(`${at}.eval_set must be one of ${Object.keys(H_MANIFESTS).join(", ")}`);
    if (!oneOf(STRATA, p.stratum)) out.push(`${at}.stratum must be one of ${STRATA.join(", ")}`);
    if (typeof p.image !== "string" || !IMAGE.test(p.image) || p.image.split("/").includes("..")) out.push(`${at}.image must be a plain image path`);
    if (typeof p.image_sha256 !== "string" || !HEX64.test(p.image_sha256)) out.push(`${at}.image_sha256 must be a sha256`);
    const size = Array.isArray(p.image_size) && p.image_size.length === 2 && p.image_size.every((n) => isInt(n) && n > 0) ? (p.image_size as [number, number]) : null;
    if (!size) out.push(`${at}.image_size must be [width, height] in pixels`);
    if (p.coordinate_frame !== "display") out.push(`${at}.coordinate_frame must be display (boxes in the EXIF-rotated frame)`);
    if (!(isInt(p.exif_orientation) && p.exif_orientation >= 1 && p.exif_orientation <= 8)) out.push(`${at}.exif_orientation must be 1-8`);
    if (!(p.page_flag === null || oneOf(PAGE_FLAGS, p.page_flag))) out.push(`${at}.page_flag must be null or one of ${PAGE_FLAGS.join(", ")}`);
    if (typeof p.page_key === "string") {
      const m = manifest.get(p.page_key);
      if (!m) out.push(`${at}: ${p.page_key} is in neither registered manifest`);
      else {
        if (m.eval_set !== p.eval_set) out.push(`${at}: ${p.page_key} is in the ${m.eval_set} manifest, not ${String(p.eval_set)}`);
        if (m.stratum !== p.stratum) out.push(`${at}.stratum differs from the manifest's (${m.stratum})`);
        if (m.image_sha256 !== p.image_sha256) out.push(`${at}.image_sha256 differs from the manifest's`);
        out.push(...manifestRowProblems(at, m));
      }
    }
    if (!Array.isArray(p.lines)) return void out.push(`${at}.lines must be an array`);
    const is = new Set<number>();
    p.lines.forEach((l: unknown, j: number) => {
      const lat = `${at}.lines[${j}]`;
      if (!isObj(l)) return void out.push(`${lat} must be an object`);
      if (!(isInt(l.i) && l.i >= 0)) out.push(`${lat}.i must be a non-negative integer`);
      else if (is.has(l.i)) out.push(`${lat}.i ${l.i} is repeated`);
      else is.add(l.i);
      // From scratch: no text of any kind comes in.
      if (l.prefill !== "") out.push(`${lat}.prefill must be empty (lines are typed from scratch)`);
      out.push(...boxProblems(`${lat}.box`, l.box, size));
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The export: h_line_transcriptions.v0

/** The actions agreement.py knows, as the export gives them (what eval's ingest recomputes outcomes from). */
export const H_ACTIONS = ["edit", "print_has_niqqud", "unreadable", "not_on_page"] as const;
export type HAction = (typeof H_ACTIONS)[number];
/**
 * What a volunteer can record on a box. Three of them say the box holds no line of its own, and agreement.py
 * scores all three as not_on_page; the export keeps which one as `box_reason`, for re-boxing (lead, 2026-11-18):
 * - not_on_page: the box doesn't hold one line (two lines merged);
 * - no_text: a false box (stain, stamp, bleed-through);
 * - continued: a piece of a split line; the whole line is typed in its first (rightmost) piece.
 */
export const H_APP_ACTIONS = ["edit", "print_has_niqqud", "unreadable", "not_on_page", "no_text", "continued"] as const;
export type HAppAction = (typeof H_APP_ACTIONS)[number];
export const BOX_REASONS = ["not_one_line", "no_text", "continued"] as const;
export type BoxReason = (typeof BOX_REASONS)[number];
export const AGREEMENT_ACTION: Record<HAppAction, HAction> = {
  edit: "edit",
  print_has_niqqud: "print_has_niqqud",
  unreadable: "unreadable",
  not_on_page: "not_on_page",
  no_text: "not_on_page",
  continued: "not_on_page",
};
export const BOX_REASON: Partial<Record<HAppAction, BoxReason>> = { not_on_page: "not_one_line", no_text: "no_text", continued: "continued" };
/** agreement.py's action for a recorded value (identity for values it knows). */
export const agreementAction = (v: string): string => AGREEMENT_ACTION[v as HAppAction] ?? v;

export const H_ROLES = ["first", "second", "third", "extra", "maintainer"] as const;
export const H_NOT_COUNTED = ["fewer_than_20_gold", "below_floor", "excluded_by_admin", "maintainer"] as const;
export const H_OUTCOMES = ["agreed", "majority", "to_maintainer", "maintainer", "pending"] as const;
/** A page flag a volunteer raises: a text line on the page that no box covers (to the maintainer's queue). */
export const PAGE_FLAG_KINDS = ["text_outside_boxes"] as const;
export type PageFlagKind = (typeof PAGE_FLAG_KINDS)[number];

export interface HExportDecision {
  decision_id: string;
  reviewer: string;
  page_key: string;
  i: number;
  action: HAction;
  /** For not_on_page: which of the three box problems the volunteer recorded. */
  box_reason: BoxReason | null;
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
  /** The box, in pixels of the displayed page (as in the box file). */
  box: PixelBox;
  outcome: (typeof H_OUTCOMES)[number];
  /** box_reason: for a not_on_page reference, the deciding decisions' reason, or "mixed" when they differ. */
  reference: null | { action: HAction; text: string | null; box_reason: BoxReason | "mixed" | null };
  decision_ids: string[];
}

/**
 * A split line: the piece whose reference is the typed line (`first`), and the pieces whose reference is continued
 * that join it. A continued piece joins the nearest piece to its right in the same row that is not itself
 * continued or another box problem (by geometry: box order is not reliable inside a fragmented row).
 */
export interface HExportJoin {
  page_key: string;
  /** The piece the line is typed in; null when no piece in the row can hold it (reason "unattached": re-box). */
  first: number | null;
  pieces: number[];
  reason: "unattached" | null;
}

export interface HExportPageFlag {
  page_key: string;
  kind: PageFlagKind;
  /** Each volunteer's report: one per volunteer per page. */
  reports: { reviewer: string; reported_at: string }[];
  /** The maintainer's answer: confirmed (re-box the page), dismissed, or null while it waits in his queue. */
  maintainer: null | { answer: "confirmed" | "dismissed"; reviewer: string; answered_at: string };
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
  joins: HExportJoin[];
  page_flags: HExportPageFlag[];
  /** Pages of the box file not in the queue, and why (no_hebrew_text: until eval rules; no_boxes: nothing to type). */
  held_pages: { page_key: string; reason: string }[];
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
  if (!Array.isArray(raw.joins) || !Array.isArray(raw.page_flags) || !Array.isArray(raw.held_pages)) out.push("joins, page_flags and held_pages must be arrays");
  const ids = new Set<string>();
  raw.decisions.forEach((d: unknown, k: number) => {
    const at = `decisions[${k}]`;
    if (!isObj(d)) return void out.push(`${at} must be an object`);
    if (!isStr(d.decision_id) || ids.has(d.decision_id)) out.push(`${at}.decision_id must be unique`);
    else ids.add(d.decision_id);
    out.push(...reviewerIdProblems(d.reviewer).map((m) => `${at}.reviewer ${m}`));
    if (!known.has(`${String(d.page_key)}#l${String(d.i)}`)) out.push(`${at} is not a line of this batch`);
    if (!oneOf(H_ACTIONS, d.action)) out.push(`${at}.action must be one of ${H_ACTIONS.join(", ")}`);
    else if ((d.action === "not_on_page") !== oneOf(BOX_REASONS, d.box_reason)) out.push(`${at}.box_reason must be given exactly for not_on_page`);
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
