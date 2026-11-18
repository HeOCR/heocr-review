/**
 * Task type `line_verify`: a human looks at one printed line on a real scan and a candidate transcription of it
 * (written by a different human: a Wikisource quality-3 proofreader, or Project Ben-Yehuda text aligned to an NLI
 * scan) and marks it exact, edits it, or marks it unreadable or misaligned. `pointed_print` says the letters match
 * but the print has niqqud the candidate lacks; with the letters corrected (niqqud left out) it carries `text`. The export is
 * line_verify_decisions.v1.1 (v1.2 for a line_verify_items.v1.1 batch, with each decision's pass), which hocrgen
 * ingests; its attestation policy, not this app, decides what a verified line becomes. A v1.1 line can carry the agent
 * pre-check's "look here" (never a text) and a blind second pass (`<item_id>@pass2`, see importer.ts).
 *
 * Generic model mapping: a bundle page is an item, a line is a proposal (category = stratum, confidence =
 * candidate_provenance), the queue rank is the bundle's rank (ties by item_id).
 */
import { attentionRuns } from "../../shared/attention";
import type { DecisionOption, Label, LineVerifyView } from "../../shared/api";
import type { Box } from "../../shared/media";
import { imageUrl } from "../../shared/media";
import { sha256Hex } from "../../shared/sha256";
import type { BatchRecord, DecisionRecord, ExportExtra, ExportFile, NormalizedDecision, ProposalRecord, ResolvedProposal, StoredImage, TaskType, VerifyVote } from "../types";
import { GATE_BATCH_ID, LINE_FOLD_V1_SHA256, referenceOf, routeLine, type CountedVote } from "./resolution";
import {
  DECISIONS_SCHEMA,
  BLIND_LIST_SHA256_OF,
  BOX_REASONS,
  DECISIONS_SCHEMA_V12,
  DECISIONS_SCHEMA_V13,
  DECISIONS_SCHEMA_V14,
  itemsLevel,
  decisionId,
  decisionsFileProblems,
  hasNiqqud,
  lineTextProblems,
  type LvDecision,
  type LvPage,
  type PixelBox,
} from "./schema";

export const TASK_TYPE_ID = "line_verify";

/** What the importer stores per line (proposals.payload_json). */
export interface LineVerifyPayload {
  page_id: string;
  line_index: number;
  box: PixelBox;
  context_box: PixelBox;
  candidate_text: string;
  candidate_provenance: string;
  alignment_score: number;
  attention_spans: [number, number][];
  difficulty: number;
  stratum: string;
  /** The bundle's own rank (the stored rank is its dense, tie-broken order). */
  bundle_rank: number;
  /** Position in items.json, so the export keeps hocrgen's order. */
  order: number;
  /** The bundle's item id (a pass-2 proposal's external id is `<item_id>@pass2`). Absent on lines imported before v1.1. */
  item_id?: string;
  /** 2: the blind second pass. Absent (1) on lines imported before v1.1. */
  pass?: 1 | 2;
  /** The line has a blind second pass. */
  blind?: boolean;
  /** v1.2: "type" lines have no candidate (candidate_text "") and are typed from a blank box. Absent: "verify". */
  kind?: "verify" | "type";
  /** The agent pre-check's "look here" (pass 1 of a flagged v1.1 line only): never a proposed text. */
  precheck?: { reasons: string[] } | null;
  /** The page's metadata, copied onto each line so a line can be shown with its attribution. */
  page: Pick<LvPage, "source" | "book_id" | "book_title" | "page_label" | "text_license" | "attribution" | "release_split" | "width" | "height" | "sha256"> & {
    script?: LvPage["script"] | null;
    /** v1.2 pages. */
    book_group?: string;
    kraken_lines?: number;
  };
}

/** What the importer stores per batch (batches.source_json). */
export interface LineVerifySource {
  schema_version: string;
  /** v1.1: the bundle's blind_second_pass list, as a count and a checksum (BLIND_LIST_SHA256_OF). */
  blind_second_pass?: { count: number; sha256: string };
  batch_id: string;
  description: string;
  created_at: string;
  generator: { tool: string; ref?: string };
}

export const SOURCE_LABELS: Record<string, Label> = {
  wikisource_he_proofread: { he: "ויקיטקסט", en: "Hebrew Wikisource" },
  benyehuda_nli_aligned: { he: "פרויקט בן־יהודה, סריקת הספרייה הלאומית", en: "Project Ben-Yehuda text, NLI scan" },
  sefaria_edition: { he: "ספריא, נוסח המהדורה", en: "Sefaria, the edition's text" },
  gutenberg_edition: { he: "פרויקט גוטנברג, נוסח המהדורה", en: "Project Gutenberg, the edition's text" },
  benyehuda_text: { he: "פרויקט בן־יהודה", en: "Project Ben-Yehuda" },
  wikisource_he: { he: "ויקיטקסט", en: "Hebrew Wikisource" },
};

export const PROVENANCE_LABELS: Record<string, Label> = {
  wikisource_quality3_single_proofreader: { he: "הוגה בידי מגיה אחד בוויקיטקסט", en: "Proofread once on Wikisource" },
  pby_human_typed_aligned: { he: "הוקלד בידי אדם (בן־יהודה), מותאם לסריקה", en: "Human-typed (Ben-Yehuda), aligned to the scan" },
  sefaria_exact_edition: { he: "נוסח המהדורה הזאת בספריא", en: "This edition's text on Sefaria" },
  gutenberg_exact_edition: { he: "נוסח המהדורה הזאת בפרויקט גוטנברג", en: "This edition's text on Project Gutenberg" },
  pby_human_typed: { he: "הוקלד בידי אדם (בן־יהודה)", en: "Human-typed (Ben-Yehuda)" },
  wikisource_quality4_validated: { he: "הוגה ואומת בוויקיטקסט", en: "Proofread and validated on Wikisource" },
  wikisource_quality1_unproofread: { he: "לא הוגה (ויקיטקסט)", en: "Not proofread (Wikisource)" },
};

export const PRECHECK_LABELS: Record<string, Label> = {
  edge_mismatch: { he: "קצה השורה", en: "line edge" },
  spelling: { he: "כתיב", en: "spelling" },
  digits: { he: "ספרות", en: "digits" },
};

export const SCRIPT_LABELS: Record<string, Label> = {
  square: { he: "אותיות מרובעות", en: "Square script" },
  rashi: { he: "כתב רש״י", en: "Rashi script" },
};

const OPTIONS: DecisionOption[] = [
  { value: "exact", label: { he: "מדויק", en: "Exact" }, withText: false },
  { value: "edited", label: { he: "עריכה", en: "Edit" }, withText: true },
  { value: "unreadable", label: { he: "לא קריא", en: "Unreadable" }, withText: false },
  { value: "misaligned", label: { he: "לא תואם", en: "Misaligned" }, withText: false },
  // The letters match, the print is pointed and the candidate is not. Edit's "print has niqqud" box sends it with text.
  { value: "pointed_print", label: { he: "בדפוס יש ניקוד", en: "Print has niqqud" }, withText: false },
];

/** A v1.2 verify line: misaligned carries the line as typed (heocr-eval: every line needs a text). */
const OPTIONS_V12: DecisionOption[] = OPTIONS.map((o) =>
  o.value === "misaligned" ? { ...o, label: { he: "לא תואם (הקלדה)", en: "Misaligned (type the line)" }, withText: true } : o,
);

/** A typed line (v1.2 kind "type"), either pass: typed from a blank box, or one of H's box problems. */
const TYPE_OPTIONS: DecisionOption[] = [
  { value: "typed", label: { he: "הקלדה", en: "Type" }, withText: true },
  { value: "pointed_print", label: { he: "בדפוס יש ניקוד", en: "Print has niqqud" }, withText: true },
  { value: "unreadable", label: { he: "לא קריא", en: "Unreadable" }, withText: false },
  { value: "not_one_line", label: { he: "לא שורה אחת", en: "Not one line" }, withText: false },
  { value: "no_text", label: { he: "אין כאן טקסט", en: "No text here" }, withText: false },
  { value: "continued", label: { he: "המשך שורה", en: "Continued" }, withText: false },
];

/** A blind second pass: the line is typed from a blank box (pointed_print: the print is pointed, letters typed only). */
const PASS2_OPTIONS: DecisionOption[] = [
  { value: "typed", label: { he: "הקלדה", en: "Type" }, withText: true },
  { value: "pointed_print", label: { he: "בדפוס יש ניקוד", en: "Print has niqqud" }, withText: true },
  { value: "unreadable", label: { he: "לא קריא", en: "Unreadable" }, withText: false },
  { value: "misaligned", label: { he: "לא תואם", en: "Misaligned" }, withText: false },
];

function payloadOf(p: ProposalRecord): LineVerifyPayload {
  return p.payload as unknown as LineVerifyPayload;
}

function sourceOf(batch: BatchRecord): LineVerifySource {
  return batch.source as unknown as LineVerifySource;
}

function imageView(img: StoredImage | undefined) {
  return img ? { url: imageUrl(img.ref), width: img.width, height: img.height, box: img.box as Box | null, outlined: img.outlined === true } : null;
}

const label = (labels: Record<string, Label>, id: string): Label => labels[id] ?? { he: id, en: id };

const passOf = (p: ProposalRecord): 1 | 2 => payloadOf(p).pass ?? 1;
export const isPass2 = (p: ProposalRecord) => passOf(p) === 2;
const kindOf = (p: ProposalRecord): "verify" | "type" => payloadOf(p).kind ?? "verify";
/** A line of a v1.2 batch (its payload says its kind). */
const isV12Line = (p: ProposalRecord) => payloadOf(p).kind !== undefined;
/** Typed from a blank box: a typed line (either pass), or any line's blind second pass. */
const typedFromBlank = (p: ProposalRecord) => kindOf(p) === "type" || isPass2(p);
/** How many current decisions a line needs: two on a typed line's pass 1 in a group switched to two typings. */
export function needed(batch: BatchRecord, p: ProposalRecord): number {
  const two = kindOf(p) === "type" && passOf(p) === 1 && (batch.settings?.twoTypingsGroups ?? []).includes(payloadOf(p).page.book_group ?? "");
  return Math.max(batch.minReviewers, two ? 2 : 1);
}

/** The checksum of a blind_second_pass list (BLIND_LIST_SHA256_OF). */
export function blindListSha256(ids: string[]): string {
  return sha256Hex([...ids].sort().join("\n"));
}
/** The bundle's item id of a line (both passes). */
const itemIdOf = (p: ProposalRecord): string => payloadOf(p).item_id ?? p.externalId;
const levelOf = (batch: BatchRecord) => itemsLevel(sourceOf(batch).schema_version);
const allOf = (r: ResolvedProposal): DecisionRecord[] => [...r.current, ...r.stale, ...r.superseded];

/** The decision's own fields, in the contract's key order: text for edited, and for pointed_print with corrected letters. */
function body(d: DecisionRecord): Pick<LvDecision, "decision" | "text" | "box_reason"> {
  // A typed line's box problems are exported as H does: not_on_page, with the reason.
  if ((BOX_REASONS as readonly string[]).includes(d.value)) return { decision: "not_on_page", box_reason: d.value as LvDecision["box_reason"] };
  return {
    decision: d.value as LvDecision["decision"],
    ...(d.value === "edited" || d.value === "typed" ? { text: d.text ?? "" } : (d.value === "pointed_print" || d.value === "misaligned") && d.text ? { text: d.text } : {}),
  };
}

/**
 * A blind-pass line as typed: NFC, without edge whitespace, one line, and letters only (niqqud is the print-has-niqqud
 * choice, with the letters typed).
 */
export function normalizeTypedDecision(value: string, text: unknown, noText: readonly string[] = ["unreadable", "misaligned"]): NormalizedDecision {
  if (noText.includes(value)) {
    if (text !== undefined && text !== null) return { ok: false, error: "only a typed or pointed_print decision carries text" };
    return { ok: true, value, text: null };
  }
  if (value !== "typed" && value !== "pointed_print") return { ok: false, error: `decision must be typed, pointed_print, ${noText.join(", ")}` };
  if (typeof text !== "string") return { ok: false, error: "type the line" };
  const typed = text.normalize("NFC").trim();
  const problems = lineTextProblems(typed);
  if (problems.length) return { ok: false, error: `the typed line ${problems.join("; ")}` };
  if (hasNiqqud(typed)) return { ok: false, error: "type the letters only, without niqqud or marks (the print has niqqud: say so)" };
  return { ok: true, value, text: typed };
}

/**
 * A reviewer's edit as stored: NFC, without leading or trailing whitespace (a line reference has none). An edit
 * equal to the candidate is recorded as exact. A `pointed_print` text is the corrected letters only: niqqud is
 * refused, and one equal to the candidate is stored without text.
 */
export function normalizeLineDecision(candidate: string, value: string, text: unknown): NormalizedDecision {
  if (value === "exact" || value === "unreadable" || value === "misaligned") {
    if (text !== undefined && text !== null) return { ok: false, error: "only an edited or pointed_print decision carries text" };
    return { ok: true, value, text: null };
  }
  if (value === "pointed_print") {
    if (text === undefined || text === null) return { ok: true, value, text: null };
    if (typeof text !== "string") return { ok: false, error: "a pointed_print text must be the corrected letters" };
    const letters = text.normalize("NFC").trim();
    const problems = lineTextProblems(letters);
    if (problems.length) return { ok: false, error: `the corrected line ${problems.join("; ")}` };
    if (hasNiqqud(letters)) return { ok: false, error: "type the letters only, without niqqud or marks" };
    return { ok: true, value, text: letters === candidate ? null : letters };
  }
  if (value !== "edited") return { ok: false, error: "decision must be exact, edited, unreadable, misaligned or pointed_print" };
  if (typeof text !== "string") return { ok: false, error: "an edited decision needs the corrected line" };
  const edited = text.normalize("NFC").trim();
  const problems = lineTextProblems(edited);
  if (problems.length) return { ok: false, error: `the corrected line ${problems.join("; ")}` };
  if (edited === candidate) return { ok: true, value: "exact", text: null };
  return { ok: true, value: "edited", text: edited };
}

/** A v1.4 decision's counted, not_counted_reason and step, from its verify_votes row (none: not recorded). */
function voteFields(v: VerifyVote | undefined): Pick<LvDecision, "counted" | "not_counted_reason" | "step"> {
  if (!v) return { counted: false, not_counted_reason: "not_recorded", step: "uncounted" };
  return v.counted ? { counted: true, step: v.step as LvDecision["step"] } : { counted: false, not_counted_reason: v.notCountedReason as LvDecision["not_counted_reason"], step: "uncounted" };
}

/** v1.4's lines list: each line's routing from its counted current decisions (spec, "Routing"). */
function linesOf(resolved: ResolvedProposal[], votes: Map<string, VerifyVote>) {
  return resolved
    .filter((r) => passOf(r.proposal) === 1)
    .sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order)
    .map((r) => {
      const byId = new Map(r.current.map((d) => [d.id, d]));
      const counted: CountedVote[] = r.current
        .filter((d) => votes.get(d.id)?.counted)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
        .map((d) => ({ decisionId: d.id, reviewerId: d.reviewerId, value: d.value, text: d.text, createdAt: d.createdAt }));
      const adminDecided = allOf(r).some((d) => votes.get(d.id)?.byAdmin);
      const route = routeLine(counted, payloadOf(r.proposal).candidate_text, adminDecided);
      const exportId = (id: string) => decisionId(r.proposal.externalId, byId.get(id)!.reviewerId);
      return {
        item_id: itemIdOf(r.proposal),
        kind: kindOf(r.proposal),
        resolution: route.resolution,
        reference: route.reference ? referenceOf(route.reference.value) : null,
        pair: route.reference ? [exportId(route.reference.pair[0]), exportId(route.reference.pair[1])] : null,
      };
    });
}

/** v1.3's pages list: per page, its segmenter lines, how many have enough current pass-1 decisions, and how many are unreadable. */
function pagesOf(batch: BatchRecord, resolved: ResolvedProposal[]) {
  const pages = new Map<string, { page_id: string; book_group: string | null; kraken_lines: number; resolved: number; unreadable: number }>();
  for (const r of resolved) {
    if (passOf(r.proposal) !== 1) continue;
    const x = payloadOf(r.proposal);
    const page = pages.get(x.page_id) ?? { page_id: x.page_id, book_group: x.page.book_group ?? null, kraken_lines: x.page.kraken_lines ?? 0, resolved: 0, unreadable: 0 };
    if (r.current.length >= needed(batch, r.proposal)) page.resolved += 1;
    // Lines any current pass-1 decision calls unreadable (eval replaces such a page before scoring).
    if (r.current.some((d) => d.value === "unreadable")) page.unreadable += 1;
    pages.set(x.page_id, page);
  }
  return [...pages.values()].sort((a, b) => (a.page_id < b.page_id ? -1 : 1)).map((p) => ({ ...p, done: p.resolved === p.kraken_lines }));
}

export const lineVerify: TaskType = {
  id: TASK_TYPE_ID,
  label: { he: "אימות שורות מול הסריקה", en: "Line verification" },
  options: OPTIONS,
  optionsFor: (p) => (kindOf(p) === "type" ? TYPE_OPTIONS : isPass2(p) ? PASS2_OPTIONS : isV12Line(p) ? OPTIONS_V12 : OPTIONS),
  finalDecision: isPass2,
  // The page is shown only on request; prefetching it for every line would cost a phone ~10x the bytes.
  prefetch: ["crop"],

  toView(p: ProposalRecord): LineVerifyView {
    const x = payloadOf(p);
    const blind = typedFromBlank(p);
    return {
      kind: "line_verify",
      mode: blind ? "type" : "verify",
      pass: passOf(p),
      lineKind: kindOf(p),
      // The blind pass never sends the candidate: the reviewer types what the scan shows.
      candidate: blind ? "" : x.candidate_text,
      runs: blind ? [] : attentionRuns(x.candidate_text, x.attention_spans),
      lineIndex: x.line_index,
      provenance: { id: x.candidate_provenance, label: label(PROVENANCE_LABELS, x.candidate_provenance) },
      source: { id: x.page.source, label: label(SOURCE_LABELS, x.page.source) },
      bookTitle: x.page.book_title,
      pageLabel: x.page.page_label,
      attribution: x.page.attribution,
      textLicense: x.page.text_license,
      script: x.page.script ? { id: x.page.script, label: label(SCRIPT_LABELS, x.page.script) } : null,
      precheck: x.precheck && !blind ? { reasons: x.precheck.reasons.map((r) => ({ id: r, label: label(PRECHECK_LABELS, r) })) } : null,
      crop: imageView(p.media.crop),
      page: imageView(p.media.page),
    };
  },

  normalizeDecision(p: ProposalRecord, value: string, text: unknown): NormalizedDecision {
    if (kindOf(p) === "type") return normalizeTypedDecision(value, text, ["unreadable", ...BOX_REASONS]);
    if (isPass2(p)) return normalizeTypedDecision(value, text);
    if (value === "misaligned" && isV12Line(p)) {
      const typed = normalizeTypedDecision("typed", text);
      return typed.ok ? { ...typed, value: "misaligned" } : typed;
    }
    return normalizeLineDecision(payloadOf(p).candidate_text, value, text);
  },

  /**
   * v1 batches export line_verify_decisions.v1.1, as before. v1.1 batches export v1.2: every decision says its `pass`,
   * and a pass-1 decision on a blind line made after the reviewer first decided its pass 2 is `revised_after_pass2`,
   * with `pass1_at_pass2`, the pass-1 answer that stood then (the one the passes compare). v1.2 batches export v1.3:
   * also each decision's `kind`, `box_reason` on a typed line's not_on_page, the two-typings switch, and `pages`: per
   * page, how many of its segmenter lines are resolved (enough current pass-1 decisions) and whether it is done.
   */
  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[], extra?: ExportExtra): ExportFile {
    const level = levelOf(batch);
    const v12 = level >= 1;
    const v13 = level >= 2;
    // A volunteer_v1 batch (docs/specs/line_verify_volunteer_resolution_v1.md) exports v1.4.
    const v14 = v13 && batch.settings?.resolution === "volunteer_v1";
    const votes = new Map((extra?.verifyVotes ?? []).map((v) => [v.decisionId, v]));
    // Who decided each line's pass 1 (any decision, current or not), and when each reviewer first decided its pass 2.
    const pass1By = new Set<string>();
    for (const r of resolved) if (passOf(r.proposal) === 1) for (const d of allOf(r)) pass1By.add(`${itemIdOf(r.proposal)}\u0000${d.reviewerId}`);
    const pass2At = new Map<string, string>();
    for (const r of resolved) {
      if (passOf(r.proposal) !== 2) continue;
      for (const d of allOf(r)) {
        const key = `${itemIdOf(r.proposal)}\u0000${d.reviewerId}`;
        const at = pass2At.get(key);
        if (at === undefined || d.createdAt < at) pass2At.set(key, d.createdAt);
      }
    }
    const decisions: LvDecision[] = resolved
      .slice()
      .sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order || passOf(a.proposal) - passOf(b.proposal))
      .flatMap((r) => {
        const kind = kindOf(r.proposal);
        const candidateSha = kind === "type" ? null : sha256Hex(payloadOf(r.proposal).candidate_text);
        const pass = passOf(r.proposal);
        const itemId = itemIdOf(r.proposal);
        return r.current
          .slice()
          .sort((a, b) => a.reviewerId.localeCompare(b.reviewerId))
          .map((d): LvDecision => {
            const at = v12 && pass === 1 && payloadOf(r.proposal).blind ? pass2At.get(`${itemId}\u0000${d.reviewerId}`) : undefined;
            const revised = at !== undefined && d.createdAt > at;
            const standing = revised
              ? allOf(r)
                  .filter((o) => o.reviewerId === d.reviewerId && o.createdAt <= at)
                  .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
                  .pop()
              : undefined;
            return {
              decision_id: decisionId(r.proposal.externalId, d.reviewerId),
              item_id: itemId,
              reviewer: d.reviewerId,
              ...body(d),
              ...(candidateSha ? { candidate_sha256: candidateSha } : {}),
              ...(v12 ? { pass } : {}),
              ...(v13 ? { kind } : {}),
              ...(v12 && pass === 2 ? { same_reviewer: pass1By.has(`${itemId}\u0000${d.reviewerId}`) } : {}),
              ...(at !== undefined ? { revised_after_pass2: revised } : {}),
              ...(revised ? { pass1_at_pass2: standing ? { ...body(standing), decided_at: standing.decidedOn } : null } : {}),
              ...(v14 ? voteFields(votes.get(d.id)) : {}),
              decided_at: d.decidedOn,
              checked_by: "human",
            };
          });
      });
    return {
      fileName: "line_verify_decisions.json",
      content: {
        schema_version: v14 ? DECISIONS_SCHEMA_V14 : v13 ? DECISIONS_SCHEMA_V13 : v12 ? DECISIONS_SCHEMA_V12 : DECISIONS_SCHEMA,
        batch_id: sourceOf(batch).batch_id,
        // v1.2: which mode the blind pass ran in, and which list it ran on (heocr-eval, so a later reader can tell).
        ...(v12
          ? {
              pass2_reviewer: { mode: batch.settings?.pass2Reviewer ?? "same", set_at: batch.settings?.pass2ReviewerSetAt ?? null },
              blind_second_pass: { ...(sourceOf(batch).blind_second_pass ?? { count: 0, sha256: blindListSha256([]) }), sha256_of: BLIND_LIST_SHA256_OF },
            }
          : {}),
        ...(v13
          ? {
              two_typings: { groups: batch.settings?.twoTypingsGroups ?? [], set_at: batch.settings?.twoTypingsSetAt ?? null },
              pages: pagesOf(batch, resolved),
            }
          : {}),
        ...(v14 ? { resolution: "volunteer_v1", gate_batch_id: GATE_BATCH_ID, line_fold_v1_sha256: LINE_FOLD_V1_SHA256, lines: linesOf(resolved, votes) } : {}),
        decisions,
      },
    };
  },

  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[] {
    const items = proposals
      .filter((p) => p.active && passOf(p) === 1)
      .map((p) => ({
        item_id: itemIdOf(p),
        candidate_text: payloadOf(p).candidate_text,
        ...(kindOf(p) === "type" ? {} : { candidate_sha256: sha256Hex(payloadOf(p).candidate_text) }),
        blind: payloadOf(p).blind === true,
        kind: kindOf(p),
      }));
    return decisionsFileProblems(content, sourceOf(batch).batch_id, items);
  },
};
