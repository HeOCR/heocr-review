/**
 * The page review contract between heocr-eval and HeOCR Review (v0, 2026-11-12). In: eval's batch manifest
 * `heocr_midcentury_batch.v0` (batch_manifest.json, pages/) and, optionally, the blind second pass's pre-fill
 * (blind_prefill.json). Out: `page_review_decisions.v0`, which eval's ingest reads. The spec is eval's
 * tasks/eval-domains/capture/midcentury/REVIEW_BATCH_SPEC.md; field names here are the contract's own.
 *
 * A reviewer corrects a pre-filled transcription of a whole printed page, line by line, and confirms the page (or
 * rejects it). Line indices (`i`, `i_src`) are indices into prefill.splitlines(), blank lines included; every
 * non-blank pre-fill line is covered by exactly one record (a split covers it with consecutive records).
 */
import { hasNiqqud } from "../../shared/niqqud";
import { reviewerIdProblems } from "../reference_audit/schema";

export const MANIFEST_SCHEMA = "heocr_midcentury_batch.v0";
export const DECISIONS_SCHEMA = "page_review_decisions.v0";
export const ROLES = ["test", "reserve"] as const;
export const LINE_ACTIONS = ["correct", "edit", "print_has_niqqud", "not_on_page", "unreadable", "merge", "split", "added"] as const;
export type LineAction = (typeof LINE_ACTIONS)[number];
export const REJECT_REASONS = ["blank", "unreadable", "misfetched", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
/** Actions whose record carries the reviewer's text; the others have text null (correct: the pre-fill line). */
export const TEXT_ACTIONS: readonly LineAction[] = ["edit", "print_has_niqqud", "merge", "split", "added"];
export const EXCLUDED_ACTIONS: readonly LineAction[] = ["not_on_page", "unreadable"];

/** A line with a digit or a bracket: these OCR layers mirror brackets and move digits and commas (bidi risk). */
export const BIDI_RISK = /[0-9()[\]]/;
/** Hebrew letters, for eval's "at least 4 letters" rule on which lines carry a flags entry. */
const HEBREW_LETTER = /[א-ת]/gu;
export const MAX_LINE_LENGTH = 1000;
export const MAX_LINES = 800;
export const MAX_NOTE_LENGTH = 500;
/** A stored page decision (JSON) is at most this long. */
export const MAX_DECISION_LENGTH = 400_000;
/** Control characters (tab and line feed included: a line is one line), bidi controls left to the scorer's fold. */
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const HEX64 = /^[0-9a-f]{64}$/;

export interface ManifestLineFlags {
  i: number;
  match: number;
  tier_a: boolean;
  bidi_risk: boolean;
}

export interface ManifestPage {
  unit_id: string;
  stratum: string;
  series: string;
  page: number;
  role: (typeof ROLES)[number];
  image: string;
  image_sha256: string;
  source_pdf_sha256: string;
  prefill_source: string;
  prefill_from_stock: boolean;
  prefill: string;
  difficulty: number;
  lines: ManifestLineFlags[];
  node: string;
  reading_order_check: boolean;
  blind_second_pass: boolean;
}

export interface Manifest {
  schema_version: typeof MANIFEST_SCHEMA;
  split_sha256: string;
  fetch_manifest_sha256: string;
  pages: ManifestPage[];
  problems?: string[];
  counts?: Obj;
  status?: string;
}

export interface BlindPage {
  unit_id: string;
  page: number | string;
  image_sha256: string;
  first_pass_prefill_source: string;
  blind_prefill_source: string;
  blind_prefill: string;
}

export interface BlindFile {
  batch_id: string;
  pass: 2;
  manifest_sha256: string;
  pages: BlindPage[];
}

/** One shown pre-fill line: its index, its text and its "look here" flags (never a proposed correction). */
export interface PrefillLine {
  i: number;
  text: string;
  tier_a: boolean;
  bidi_risk: boolean;
  /** eval's letter agreement with an independent stock reading (0-100); null when the line has no flags entry. */
  match: number | null;
}

/** The manifest's page key: `<unit_id>#p<page>` (one item per page; pass 2 is `<key>@pass2`). */
export const pageKey = (unitId: string, page: number | string): string => `${unitId}#p${Number(page)}`;

/**
 * The lines a reviewer sees: every non-blank pre-fill line, with eval's flags where it has an entry. A line without
 * one (fewer than 4 Hebrew letters: page numbers, short headers) is tier A when it has a digit or bracket (eval,
 * 2026-11-12), otherwise it goes in the strip. A pass-2 pre-fill has no entries, so the same rule applies to it.
 */
export function prefillLines(prefill: string, flags: ManifestLineFlags[]): PrefillLine[] {
  const byIndex = new Map(flags.map((f) => [f.i, f]));
  return splitLines(prefill).flatMap((text, i) => {
    if (text.trim() === "") return [];
    const f = byIndex.get(i);
    const bidi = BIDI_RISK.test(text);
    return [{ i, text, tier_a: f ? f.tier_a : bidi, bidi_risk: f ? f.bidi_risk : bidi, match: f ? f.match : null }];
  });
}

/** Python's str.splitlines() for the separators a pre-fill can hold (\n, \r\n, \r, form feed and friends). */
export function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|[\n\r\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]/u);
  // splitlines() drops the empty piece after a final separator.
  if (parts.length && parts[parts.length - 1] === "" && /(\r\n|[\n\r\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029])$/u.test(text)) parts.pop();
  return text === "" ? [] : parts;
}

export function hebrewLetters(text: string): number {
  return (text.match(HEBREW_LETTER) ?? []).length;
}

export function lineTextProblems(text: unknown): string[] {
  if (typeof text !== "string") return ["must be a string"];
  const problems: string[] = [];
  if (text.trim() === "") problems.push("must not be empty");
  if (text.length > MAX_LINE_LENGTH) problems.push(`must be at most ${MAX_LINE_LENGTH} characters`);
  if (LINE_CONTROL.test(text)) problems.push("must be one line without control characters");
  if (text !== text.normalize("NFC")) problems.push("must be NFC");
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The manifest and the blind pre-fill

function pageProblems(p: unknown, at: string): string[] {
  if (!isObj(p)) return [`${at} must be an object`];
  const out: string[] = [];
  for (const k of ["unit_id", "stratum", "series", "image", "prefill_source", "node"]) {
    if (typeof p[k] !== "string" || p[k] === "") out.push(`${at}.${k} must be a non-empty string`);
  }
  if (typeof p.prefill !== "string") out.push(`${at}.prefill must be a string`);
  if (!(isInt(p.page) && p.page >= 1)) out.push(`${at}.page must be a positive integer`);
  if (!oneOf(ROLES, p.role)) out.push(`${at}.role must be test or reserve`);
  for (const k of ["image_sha256", "source_pdf_sha256"]) if (typeof p[k] !== "string" || !HEX64.test(p[k] as string)) out.push(`${at}.${k} must be a sha256`);
  for (const k of ["prefill_from_stock", "reading_order_check", "blind_second_pass"]) if (typeof p[k] !== "boolean") out.push(`${at}.${k} must be a boolean`);
  if (!(isNum(p.difficulty) && p.difficulty >= 0 && p.difficulty <= 1)) out.push(`${at}.difficulty must be a number in [0, 1]`);
  if (typeof p.image === "string" && !/^[A-Za-z0-9._/-]+\.(?:png|jpg|jpeg|webp)$/.test(p.image)) out.push(`${at}.image must be a plain image path`);
  if (p.blind_second_pass === true && p.role !== "test") out.push(`${at}: only a test page can have a blind second pass`);
  if (!Array.isArray(p.lines)) out.push(`${at}.lines must be a list`);
  else if (typeof p.prefill === "string") {
    const n = splitLines(p.prefill).length;
    const seen = new Set<number>();
    for (const [k, l] of p.lines.entries()) {
      if (!(isObj(l) && isInt(l.i) && isNum(l.match) && typeof l.tier_a === "boolean" && typeof l.bidi_risk === "boolean")) {
        out.push(`${at}.lines[${k}] must be {i, match, tier_a, bidi_risk}`);
        continue;
      }
      if (l.i < 0 || l.i >= n || seen.has(l.i)) out.push(`${at}.lines[${k}].i must be a distinct pre-fill line index`);
      else if (splitLines(p.prefill)[l.i]!.trim() === "") out.push(`${at}.lines[${k}].i points at a blank line`);
      seen.add(l.i);
    }
  }
  return out;
}

export function manifestProblems(raw: unknown, blind?: unknown): string[] {
  if (!isObj(raw)) return ["the manifest must be a JSON object"];
  if (raw.schema_version !== MANIFEST_SCHEMA) return [`schema_version must be ${MANIFEST_SCHEMA}`];
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) return ["pages must be a non-empty list"];
  const out = raw.pages.flatMap((p, k) => pageProblems(p, `pages[${k}]`));
  const keys = new Set<string>();
  const images = new Set<string>();
  for (const p of raw.pages as Obj[]) {
    const key = pageKey(String(p.unit_id), Number(p.page));
    if (keys.has(key)) out.push(`${key}: listed twice`);
    keys.add(key);
    const base = String(p.image).split("/").pop()!;
    if (images.has(base)) out.push(`${key}: image file name ${base} is used twice`);
    images.add(base);
  }
  if (blind !== undefined) out.push(...blindProblems(blind, raw.pages as ManifestPage[]));
  return out;
}

function blindProblems(raw: unknown, pages: ManifestPage[]): string[] {
  if (!isObj(raw)) return ["blind_prefill.json must be a JSON object"];
  if (raw.pass !== 2) return ["blind_prefill.json: pass must be 2"];
  if (!Array.isArray(raw.pages)) return ["blind_prefill.json: pages must be a list"];
  const byKey = new Map(pages.map((p) => [pageKey(p.unit_id, p.page), p]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [k, b] of raw.pages.entries()) {
    if (!(isObj(b) && typeof b.unit_id === "string" && typeof b.blind_prefill === "string" && typeof b.blind_prefill_source === "string")) {
      out.push(`blind_prefill.json pages[${k}] must have unit_id, page, blind_prefill and blind_prefill_source`);
      continue;
    }
    const key = pageKey(b.unit_id, b.page as number | string);
    const page = byKey.get(key);
    if (!page) out.push(`blind ${key}: not in the manifest`);
    else if (!page.blind_second_pass) out.push(`blind ${key}: the manifest does not mark it blind_second_pass`);
    else if (b.image_sha256 !== page.image_sha256) out.push(`blind ${key}: image_sha256 differs from the manifest`);
    else if (b.blind_prefill.trim() !== "" && b.blind_prefill === page.prefill) out.push(`blind ${key}: the blind pre-fill equals the first pass's`);
    if (seen.has(key)) out.push(`blind ${key}: listed twice`);
    seen.add(key);
  }
  for (const p of pages) if (p.blind_second_pass && !seen.has(pageKey(p.unit_id, p.page))) out.push(`blind ${pageKey(p.unit_id, p.page)}: no blind pre-fill`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// A reviewer's page decision (what the app stores as the decision's text, as canonical JSON)

export interface LineRecord {
  i_src: number[];
  action: LineAction;
  /** The line's text: the pre-fill line for correct, the reviewer's for the text actions, null when excluded. */
  text: string | null;
}

export type PageDecision =
  | { page_action: "confirm"; reading_order_verified: boolean | null; lines: LineRecord[] }
  | { page_action: "reject"; reject_reason: RejectReason; reject_note: string | null };

/** What the browser sends: value confirm|reject, and text = JSON of this. */
export interface PageDecisionInput {
  lines?: { src: number[]; action: string; text?: string | null }[];
  reading_order_verified?: boolean | null;
  reject_reason?: string;
  reject_note?: string | null;
}

export type Normalized = { ok: true; decision: PageDecision } | { ok: false; error: string };

/**
 * Check and normalise a page decision against the lines shown. An edit equal to the pre-fill line becomes correct;
 * a correct line's text is the pre-fill line. Records come in the page's final reading order: every shown line is
 * covered once (a merge covers several, a split's consecutive pieces cover one); lines may be moved.
 */
export function normalizePageDecision(
  shown: PrefillLine[],
  readingOrderCheck: boolean,
  value: string,
  input: unknown,
): Normalized {
  const fail = (error: string): Normalized => ({ ok: false, error });
  if (!isObj(input)) return fail("the page decision must be an object");
  if (value === "reject") {
    if (!oneOf(REJECT_REASONS, input.reject_reason)) return fail(`reject_reason must be one of ${REJECT_REASONS.join(", ")}`);
    const note = input.reject_note === undefined || input.reject_note === null ? null : input.reject_note;
    if (note !== null && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH || LINE_CONTROL.test(note))) {
      return fail(`reject_note must be one line of at most ${MAX_NOTE_LENGTH} characters`);
    }
    const clean = note === null ? null : note.normalize("NFC").trim() || null;
    if (input.reject_reason === "other" && !clean) return fail("say why the page is rejected");
    if (Array.isArray(input.lines) && input.lines.length) return fail("a rejected page has no lines");
    return { ok: true, decision: { page_action: "reject", reject_reason: input.reject_reason, reject_note: clean } };
  }
  if (value !== "confirm") return fail("decision must be confirm or reject");
  const ro = input.reading_order_verified;
  if (readingOrderCheck && ro !== true) return fail("confirm the reading order first (or reject the page)");
  if (!readingOrderCheck && ro !== undefined && ro !== null) return fail("this page has no reading-order check");
  if (!Array.isArray(input.lines)) return fail("lines must be a list");
  if (input.lines.length > MAX_LINES) return fail(`at most ${MAX_LINES} lines`);
  const byIndex = new Map(shown.map((l) => [l.i, l]));
  const covered = new Set<number>();
  const out: LineRecord[] = [];
  let prevSplit: number | null = null;
  for (const [k, raw] of input.lines.entries()) {
    const at = `line ${k + 1}`;
    if (!isObj(raw) || !Array.isArray(raw.src) || !raw.src.every(isInt)) return fail(`${at}: src must be a list of line indices`);
    if (!oneOf(LINE_ACTIONS, raw.action)) return fail(`${at}: unknown action`);
    let action: LineAction = raw.action;
    const src = raw.src as number[];
    for (const i of src) if (!byIndex.has(i)) return fail(`${at}: line ${i} is not on this page's pre-fill`);
    // Cover each shown line once; a split's consecutive pieces share one.
    if (action === "split") {
      if (src.length !== 1) return fail(`${at}: a split piece comes from one line`);
      if (prevSplit !== src[0]) {
        if (covered.has(src[0]!)) return fail(`${at}: line ${src[0]} is covered twice`);
        covered.add(src[0]!);
      }
    } else {
      if (action === "added" ? src.length !== 0 : action === "merge" ? src.length < 2 : src.length !== 1) {
        return fail(`${at}: ${action === "added" ? "an added line has no source line" : action === "merge" ? "a merge joins two or more lines" : "this action is on one line"}`);
      }
      for (const i of src) {
        if (covered.has(i)) return fail(`${at}: line ${i} is covered twice`);
        covered.add(i);
      }
    }
    prevSplit = action === "split" ? src[0]! : null;
    let text: string | null = null;
    if (TEXT_ACTIONS.includes(action) || action === "correct") {
      const pre = byIndex.get(src[0]!)?.text.normalize("NFC").trim() ?? null;
      if (action === "correct") {
        const sent = typeof raw.text === "string" ? raw.text.normalize("NFC").trim() : raw.text;
        if (sent !== undefined && sent !== null && sent !== pre) return fail(`${at}: a correct line keeps the pre-fill text`);
        text = pre;
      } else {
        if (typeof raw.text !== "string") return fail(`${at}: type the line's text`);
        const typed = raw.text.normalize("NFC").trim();
        const problems = lineTextProblems(typed);
        if (problems.length) return fail(`${at}: the text ${problems.join("; ")}`);
        if (action === "print_has_niqqud" && hasNiqqud(typed)) return fail(`${at}: type the letters only, without niqqud`);
        if (action === "edit" && typed === pre) action = "correct";
        text = typed;
      }
    } else if (raw.text !== undefined && raw.text !== null) {
      return fail(`${at}: a line marked ${action} has no text`);
    }
    out.push({ i_src: [...src], action, text });
  }
  // Split pieces must stay together, and a lone "split" is a plain line.
  const groups = new Map<number, number>();
  for (const r of out) if (r.action === "split") groups.set(r.i_src[0]!, (groups.get(r.i_src[0]!) ?? 0) + 1);
  for (const [i, n] of groups) if (n < 2) return fail(`line ${i}: a split makes two or more lines`);
  for (const l of shown) if (!covered.has(l.i)) return fail(`pre-fill line ${l.i} is not covered (mark it not on the page if it is not)`);
  return { ok: true, decision: { page_action: "confirm", reading_order_verified: readingOrderCheck ? true : null, lines: out } };
}

// ---------------------------------------------------------------------------------------------------------------
// The decisions file

export interface ExportLine extends LineRecord {
  reference_views: string[];
}

export interface PrDecision {
  decision_id: string;
  batch_id: string;
  unit_id: string;
  page: number;
  image_sha256: string;
  prefill_source: string;
  prefill_sha256: string;
  reviewer: string;
  pass: 1 | 2;
  blind_second_pass: boolean;
  page_action: "confirm" | "reject";
  reject_reason?: RejectReason;
  reject_note?: string | null;
  reading_order_verified: boolean | null;
  lines: ExportLine[];
  counts: { tier_a: number; edited: number; excluded: number };
  decided_at: string;
  first_decided_at: string;
  /**
   * Pass-1 records of a page whose blind second pass the same reviewer decided: true when this pass-1 decision was
   * made after their first pass-2 decision (the passes are then no longer independent).
   */
  revised_after_pass2?: boolean;
  /** With revised_after_pass2: the pass-1 decision that stood when pass 2 was first decided (null if none). */
  pass1_at_pass2?: { page_action: "confirm" | "reject"; reading_order_verified: boolean | null; lines: ExportLine[]; decided_at: string; reject_reason?: RejectReason; reject_note?: string | null } | null;
  checked_by: "human";
}

export interface DecisionsFile {
  schema_version: typeof DECISIONS_SCHEMA;
  batch_id: string;
  decisions: PrDecision[];
}

export const referenceViews = (action: LineAction): string[] => (action === "print_has_niqqud" ? ["consonantal"] : ["primary", "consonantal"]);
export const decisionIdFor = (proposalId: string, reviewer: string): string => `decision:${proposalId}:${reviewer}`;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Problems with a decisions file; `pages` maps each exported proposal id to what it showed. */
export function decisionsFileProblems(
  raw: unknown,
  batchId: string,
  pages: Map<string, { unitId: string; page: number; imageSha256: string; prefillSha256: string; pass: 1 | 2; shown: PrefillLine[]; readingOrderCheck: boolean }>,
): string[] {
  if (!isObj(raw)) return ["the decisions file must be a JSON object"];
  const out: string[] = [];
  if (raw.schema_version !== DECISIONS_SCHEMA) out.push(`schema_version must be ${DECISIONS_SCHEMA}`);
  if (raw.batch_id !== batchId) out.push(`batch_id must be ${batchId}`);
  if (!Array.isArray(raw.decisions)) return [...out, "decisions must be a list"];
  const ids = new Set<string>();
  for (const [k, d] of raw.decisions.entries()) {
    const at = `decisions[${k}]`;
    if (!isObj(d)) {
      out.push(`${at} must be an object`);
      continue;
    }
    const id = String(d.decision_id);
    if (ids.has(id)) out.push(`${at}: decision_id ${id} repeats`);
    ids.add(id);
    out.push(...reviewerIdProblems(d.reviewer).map((p) => `${at}.reviewer ${p}`));
    const m = /^decision:(.+):(rv_[0-9a-f]{8})$/.exec(id);
    const page = m ? pages.get(m[1]!) : undefined;
    if (!m || m[2] !== d.reviewer || !page) {
      out.push(`${at}: decision_id must be decision:<page>:<reviewer> for a page of this batch`);
      continue;
    }
    if (d.batch_id !== batchId || d.unit_id !== page.unitId || d.page !== page.page || d.image_sha256 !== page.imageSha256 || d.prefill_sha256 !== page.prefillSha256) {
      out.push(`${at}: batch_id, unit_id, page, image_sha256 and prefill_sha256 must be the page's`);
    }
    if (d.pass !== page.pass) out.push(`${at}: pass must be ${page.pass}`);
    if (d.pass === 2 && d.blind_second_pass !== true) out.push(`${at}: a pass-2 record must be blind_second_pass`);
    if (!(typeof d.decided_at === "string" && ISO.test(d.decided_at) && typeof d.first_decided_at === "string" && ISO.test(d.first_decided_at))) {
      out.push(`${at}: decided_at and first_decided_at must be ISO UTC timestamps`);
    } else if (d.first_decided_at > d.decided_at) out.push(`${at}: first_decided_at is after decided_at`);
    if (d.checked_by !== "human") out.push(`${at}: checked_by must be human`);
    if (d.revised_after_pass2 !== undefined) {
      if (d.pass !== 1 || typeof d.revised_after_pass2 !== "boolean") out.push(`${at}: revised_after_pass2 is a boolean on pass-1 records only`);
      else if (d.revised_after_pass2 !== Object.prototype.hasOwnProperty.call(d, "pass1_at_pass2")) {
        out.push(`${at}: pass1_at_pass2 comes exactly with revised_after_pass2: true`);
      }
    }
    if (d.page_action === "reject") {
      if (!(Array.isArray(d.lines) && d.lines.length === 0)) out.push(`${at}: a rejected page has lines []`);
      if (!oneOf(REJECT_REASONS, d.reject_reason)) out.push(`${at}: reject_reason must be one of ${REJECT_REASONS.join(", ")}`);
      continue;
    }
    if (d.page_action !== "confirm") {
      out.push(`${at}: page_action must be confirm or reject`);
      continue;
    }
    if (!Array.isArray(d.lines)) {
      out.push(`${at}: lines must be a list`);
      continue;
    }
    for (const [j, l] of (d.lines as Obj[]).entries()) {
      const action = l.action as LineAction;
      const views = JSON.stringify(l.reference_views);
      if (views !== JSON.stringify(referenceViews(action))) out.push(`${at}.lines[${j}]: reference_views must be ${JSON.stringify(referenceViews(action))}`);
      if (EXCLUDED_ACTIONS.includes(action) ? l.text !== null : typeof l.text !== "string") out.push(`${at}.lines[${j}]: text must be ${EXCLUDED_ACTIONS.includes(action) ? "null" : "a string"}`);
    }
    // The lines must pass the same check the app ran when the reviewer saved them.
    const again = normalizePageDecision(page.shown, page.readingOrderCheck, "confirm", {
      reading_order_verified: d.reading_order_verified,
      lines: (d.lines as Obj[]).map((l) => ({ src: l.i_src, action: l.action, text: l.text })),
    });
    if (!again.ok) out.push(`${at}: ${again.error}`);
    else if (again.decision.page_action === "confirm" && JSON.stringify(again.decision.lines) !== JSON.stringify((d.lines as Obj[]).map((l) => ({ i_src: l.i_src, action: l.action, text: l.text })))) {
      out.push(`${at}: lines are not in normal form`);
    }
  }
  return out;
}
