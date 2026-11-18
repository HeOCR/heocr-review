/**
 * Task type `line_transcribe`: the handwriting (H) eval pages, transcribed one line at a time from scratch (heocr-eval
 * h_eval_v1, amendments 1 and 2). The volunteer sees the line cut from the page, the band around it and the page on
 * request, and types the line; nothing machine-made is ever shown. Each line goes to two transcribers who never see
 * each other's text; a disagreement sends it to a blind third; with no majority it goes to the maintainer, who sees
 * only the image.
 *
 * It runs on the volunteer line machinery of line_consensus (the line_state table, the queue, the maintainer's
 * tie-break, agreement.py's rule), with three differences:
 * - no pre-fill: the stored payload has prefill "" and every text decision is typed;
 * - no gold in this batch: whose decisions count is the volunteer's standing in the mid-century volunteer batch
 *   (GATE_BATCH_ID); anyone may transcribe, and other decisions are kept and do not count;
 * - strata are kept apart, and other_hebrew_script lines are served only to volunteers who say, for the session,
 *   that they read the page's language.
 */
import type { DecisionOption, LineTranscribeView } from "../../shared/api";
import { imageUrl } from "../../shared/media";
import { hasNiqqud } from "../../shared/niqqud";
import { lineTextProblems } from "../page_review/schema";
import { GOLD_FLOOR, GOLD_MIN, notCountedReason, standing, value, type LineAction, type StandingState } from "../line_consensus/consensus";
import { routeLine, standingOf, type StandingRow } from "../line_consensus/index";
import { AGREEMENT_PY_SHA256 } from "../line_consensus/schema";
import type { BatchRecord, DecisionRecord, ExportExtra, ExportFile, NormalizedDecision, ProposalRecord, ResolvedProposal, StoredImage, TaskType } from "../types";
import type { Box } from "../../shared/media";
import {
  BOX_REASON,
  GATE_BATCH_ID,
  H_APP_ACTIONS,
  H_DECISIONS_SCHEMA,
  LANGUAGE_LABELS,
  SPAN_MARKER,
  agreementAction,
  hDecisionsFileProblems,
  type BoxReason,
  type HAction,
  type HAppAction,
  type HExportJoin,
  type HExportPageFlag,
  type PageFlagKind,
  type PixelBox,
  type HDecisionsFile,
  type HExportDecision,
  type HExportLine,
  type HExportReviewer,
  type Stratum,
} from "./schema";

export const TASK_TYPE_ID = "line_transcribe";

/**
 * What the importer stores per line. `prefill`, `box_status` and `gold` are fixed ("", "matched", null) so the
 * line_consensus routing applies unchanged.
 */
export interface LineTranscribePayload {
  page_key: string;
  i: number;
  prefill: "";
  box_status: "matched";
  gold: null;
  eval_set: string;
  stratum: Stratum;
  languages: string[];
  attribution: string;
  license_expression: string;
  image_sha256: string;
  order: number;
  /** The box in pixels of the displayed page (as in the box file). */
  box: PixelBox;
  page_box: Box;
  context_box: Box;
}

export interface LineTranscribeSource {
  schema_version: string;
  batch_id: string;
  gate_batch_id: string;
  sources: Record<string, string | null>;
  /** Pages of the box file not imported, and why. */
  held_pages?: { page_key: string; reason: string }[];
}

export const payloadOf = (p: ProposalRecord): LineTranscribePayload => p.payload as unknown as LineTranscribePayload;
const sourceOf = (batch: BatchRecord): LineTranscribeSource => batch.source as unknown as LineTranscribeSource;
export const gateBatchOf = (batch: BatchRecord): string => sourceOf(batch).gate_batch_id ?? GATE_BATCH_ID;
/** The languages besides Hebrew a volunteer must read to be served this line (none outside other_hebrew_script). */
export const requiredLanguages = (x: Pick<LineTranscribePayload, "stratum" | "languages">): string[] =>
  x.stratum === "other_hebrew_script" ? x.languages.filter((l) => l !== "he") : [];

const OPTIONS: DecisionOption[] = [
  { value: "edit", label: { he: "שמירה", en: "Save" }, withText: true },
  { value: "print_has_niqqud", label: { he: "יש ניקוד (הקלדתי בלעדיו)", en: "Has niqqud (typed without)" }, withText: true },
  { value: "unreadable", label: { he: "כל השורה לא קריאה", en: "Whole line unreadable" }, withText: false },
  { value: "continued", label: { he: "חלק משורה במסגרת אחרת", en: "Part of a line in another box" }, withText: false },
  { value: "no_text", label: { he: "אין כאן טקסט", en: "No text here" }, withText: false },
  { value: "not_on_page", label: { he: "המסגרת לא מכילה שורה אחת", en: "Box doesn't hold one line" }, withText: false },
];

/** Recorded values that carry no text: the line is unreadable, or the box holds no line of its own. */
const NO_TEXT: readonly string[] = ["unreadable", "not_on_page", "no_text", "continued"];

const TEXT_LICENSE = "Transcriptions: CC0 1.0. Image: the scan's own terms (public domain).";

function imageView(img: StoredImage | undefined) {
  return img ? { url: imageUrl(img.ref), width: img.width, height: img.height, box: img.box, outlined: img.outlined === true } : null;
}

/**
 * A transcription as stored: edit and print_has_niqqud carry the typed text (NFC, trimmed; never empty);
 * print_has_niqqud's text has the letters only. There is no `correct`: nothing was shown to confirm.
 */
export function normalizeTranscription(action: string, text: unknown): NormalizedDecision {
  if (!(H_APP_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: `decision must be one of ${H_APP_ACTIONS.join(", ")}` };
  if (NO_TEXT.includes(action)) {
    if (text !== undefined && text !== null) return { ok: false, error: `a line marked ${action} carries no text` };
    return { ok: true, value: action, text: null };
  }
  if (typeof text !== "string") return { ok: false, error: "type the line's text" };
  const typed = text.normalize("NFC").trim();
  const problems = lineTextProblems(typed);
  if (problems.length) return { ok: false, error: `the text ${problems.join("; ")}` };
  if (typed.split(SPAN_MARKER).join("").trim() === "") return { ok: false, error: "nothing but illegible spans: mark the whole line unreadable" };
  if (action === "print_has_niqqud" && hasNiqqud(typed)) return { ok: false, error: "type the letters only, without niqqud" };
  return { ok: true, value: action, text: typed };
}

/** A standing map for routing from plain states (the gate batch's, as the export receives them). */
export function standingsFromStates(states: Record<string, string>, excluded: Set<string>): Map<string, StandingRow> {
  const out = new Map<string, StandingRow>();
  for (const id of new Set([...Object.keys(states), ...excluded])) {
    const s = excluded.has(id) ? "excluded" : ((states[id] ?? "provisional") as StandingState);
    out.set(id, { ...standing(0, 0, false), state: s, plantedSeen: 0, plantedHits: 0 });
  }
  return out;
}

/** agreement.py's view of a recorded decision: the three box problems are all not_on_page. */
const asLine = (d: { value: string; text: string | null }) => ({ action: agreementAction(d.value) as LineAction, text: d.text });
/** The votes routeLine takes, with values as agreement.py knows them. */
export const forAgreement = <T extends { value: string }>(d: T): T => ({ ...d, value: agreementAction(d.value) });
const boxReasonOf = (v: string): BoxReason | null => BOX_REASON[v as HAppAction] ?? null;

/** The deciding decisions' box reason for a not_on_page reference: theirs when they agree, else "mixed". */
function referenceReason(ds: { value: string }[]): BoxReason | "mixed" | null {
  const rs = [...new Set(ds.map((d) => boxReasonOf(d.value)))];
  return rs.length === 1 ? rs[0]! : "mixed";
}

/**
 * Split lines: each piece whose reference is continued joins the nearest piece to its right in the same row (boxes
 * overlapping by at least half the shorter one's height) that can hold the line: its reference is not a box problem
 * (continued, no text, not one line), or it is still pending. Hebrew runs right to left, so the line's first piece
 * is its rightmost; box order is not used (unreliable inside a fragmented row). A piece with no such piece is
 * unattached (`first` null), never joined across rows: data-collection re-boxes it.
 */
export function joinsOf(lines: { page_key: string; i: number; box: PixelBox; role: "continued" | "box_problem" | "line" }[]): HExportJoin[] {
  const out: HExportJoin[] = [];
  const byPage = new Map<string, typeof lines>();
  for (const l of lines) byPage.set(l.page_key, [...(byPage.get(l.page_key) ?? []), l]);
  for (const [page_key, ls] of byPage) {
    const groups = new Map<number | null, number[]>();
    for (const piece of ls.filter((l) => l.role === "continued")) {
      const [x0, y0, x1, y1] = piece.box;
      const cx = (x0 + x1) / 2;
      let best: { i: number; d: number } | null = null;
      for (const t of ls) {
        if (t.role !== "line" || t.i === piece.i) continue;
        const overlap = Math.min(y1, t.box[3]) - Math.max(y0, t.box[1]);
        if (overlap < 0.5 * Math.min(y1 - y0, t.box[3] - t.box[1])) continue;
        const tx = (t.box[0] + t.box[2]) / 2;
        if (tx <= cx) continue;
        if (!best || tx - cx < best.d) best = { i: t.i, d: tx - cx };
      }
      const first = best?.i ?? null;
      groups.set(first, [...(groups.get(first) ?? []), piece.i]);
    }
    for (const [first, pieces] of groups) out.push({ page_key, first, pieces: pieces.sort((a, b) => a - b), reason: first === null ? "unattached" : null });
  }
  return out.sort((a, b) => a.page_key.localeCompare(b.page_key) || (a.first ?? -1) - (b.first ?? -1));
}

function exportFile(batch: BatchRecord, resolved: ResolvedProposal[], extra: ExportExtra): HDecisionsFile {
  const src = sourceOf(batch);
  const maintainer = new Set(extra.maintainerDecisions);
  const excluded = new Map(extra.exclusions.map((e) => [e.reviewerId, e.excludedAt]));
  const standings = standingsFromStates(extra.standings ?? {}, new Set(excluded.keys()));
  const decisions: HExportDecision[] = [];
  const lines: HExportLine[] = [];
  const strata: Record<string, Record<string, number>> = {};
  const sorted = resolved.slice().sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order);
  for (const r of sorted) {
    const x = payloadOf(r.proposal);
    const ds = r.current.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.reviewerId.localeCompare(b.reviewerId));
    const base = (d: DecisionRecord) => ({
      decision_id: d.id,
      reviewer: d.reviewerId,
      page_key: x.page_key,
      i: x.i,
      action: agreementAction(d.value) as HAction,
      box_reason: boxReasonOf(d.value),
      text: d.text,
      decided_at: d.createdAt,
    });
    const vol = ds.filter((d) => !maintainer.has(d.id));
    const maint = ds.filter((d) => maintainer.has(d.id));
    const routed = routeLine(r.proposal, vol.map((d) => forAgreement({ reviewerId: d.reviewerId, value: d.value, text: d.text, at: d.createdAt })), maint.length > 0, standings);
    const roles = ["first", "second", "third"] as const;
    vol.forEach((d, k) => {
      const reason = notCountedReason(standingOf(standings, d.reviewerId).state);
      decisions.push({ ...base(d), role: roles[k] ?? "extra", counted: reason === null, not_counted_reason: reason });
    });
    for (const d of maint) decisions.push({ ...base(d), role: "maintainer", counted: false, not_counted_reason: "maintainer" });
    let outcome: HExportLine["outcome"] = "pending";
    let reference: HExportLine["reference"] = null;
    if (routed.state === "agreed" || routed.state === "majority") {
      outcome = routed.state;
      const deciding = vol.filter((d) => routed.reviewers.includes(d.reviewerId));
      const counts = new Map<string, number>();
      for (const d of deciding) counts.set(value(asLine(d), ""), (counts.get(value(asLine(d), "")) ?? 0) + 1);
      const ref = deciding.find((d) => (counts.get(value(asLine(d), "")) ?? 0) >= 2)!;
      const action = agreementAction(ref.value) as HAction;
      const same = deciding.filter((d) => value(asLine(d), "") === value(asLine(ref), ""));
      reference = { action, text: ref.text, box_reason: action === "not_on_page" ? referenceReason(same) : null };
    } else if (routed.state === "maintainer") {
      outcome = "maintainer";
      const m = maint[maint.length - 1]!;
      reference = { action: agreementAction(m.value) as HAction, text: m.text, box_reason: boxReasonOf(m.value) };
    } else if (routed.state === "to_maintainer") outcome = "to_maintainer";
    const tally = (strata[x.stratum] ??= {});
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    lines.push({ page_key: x.page_key, i: x.i, eval_set: x.eval_set, stratum: x.stratum, languages: x.languages, box: x.box, outcome, reference, decision_ids: ds.map((d) => d.id) });
  }
  const reviewers: HExportReviewer[] = [...new Set(decisions.filter((d) => d.role !== "maintainer").map((d) => d.reviewer))].sort().map((id) => {
    const mine = decisions.filter((d) => d.reviewer === id && d.role !== "maintainer");
    return { reviewer: id, standing: standingOf(standings, id).state, decisions: mine.length, decisions_counted: mine.filter((d) => d.counted).length };
  });
  return {
    schema_version: H_DECISIONS_SCHEMA,
    batch_id: src.batch_id,
    exported_at: extra.exportedAt,
    sources: { ...src.sources, "agreement.py": AGREEMENT_PY_SHA256 },
    rule: {
      gate_batch: src.gate_batch_id,
      floor: GOLD_FLOOR,
      min_gold: GOLD_MIN,
      agreement: "heocr-restricted-eval preregistration/midcentury_volunteers_2026-11-18/agreement.py",
      span_marker: SPAN_MARKER,
    },
    strata,
    decisions,
    lines,
    joins: joinsOf(
      lines.map((l) => ({
        page_key: l.page_key,
        i: l.i,
        box: l.box,
        role: l.reference?.box_reason === "continued" ? "continued" : l.reference?.action === "not_on_page" ? "box_problem" : "line",
      })),
    ),
    page_flags: (extra.pageFlags ?? []).map(
      (f): HExportPageFlag => ({
        page_key: f.pageKey,
        kind: f.kind as PageFlagKind,
        reports: f.reports.map((r) => ({ reviewer: r.reviewerId, reported_at: r.at })),
        maintainer: f.maintainer ? { answer: f.maintainer.answer, reviewer: f.maintainer.reviewerId, answered_at: f.maintainer.at } : null,
      }),
    ),
    held_pages: src.held_pages ?? [],
    reviewers,
    admin_exclusions: [...excluded].map(([reviewer, excluded_at]) => ({ reviewer, excluded_at })).sort((a, b) => a.reviewer.localeCompare(b.reviewer)),
  };
}

export const lineTranscribe: TaskType = {
  id: TASK_TYPE_ID,
  label: { he: "תעתוק כתבי יד", en: "Handwriting transcription" },
  options: OPTIONS,
  prefetch: ["page"],

  toView(p: ProposalRecord): LineTranscribeView {
    const x = payloadOf(p);
    const page = imageView(p.media.page);
    return {
      kind: "line_transcribe",
      // No stratum: a volunteer is not told a page is a seen writer's.
      languages: requiredLanguages(x).map((code) => ({ code, label: LANGUAGE_LABELS[code] ?? { he: code, en: code } })),
      spanMarker: SPAN_MARKER,
      attribution: x.attribution,
      textLicense: TEXT_LICENSE,
      // The line is cut from the page image in the browser.
      crop: page ? { ...page, box: x.page_box } : null,
      context: x.context_box,
      page: page ? { ...page, box: x.page_box } : null,
    };
  },

  normalizeDecision(_p: ProposalRecord, value: string, text: unknown): NormalizedDecision {
    return normalizeTranscription(value, text);
  },

  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[], extra?: ExportExtra): ExportFile {
    const content = exportFile(batch, resolved, extra ?? { exportedAt: new Date(0).toISOString(), exclusions: [], maintainerDecisions: [] });
    return { fileName: "h_line_transcriptions.json", content };
  },

  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[] {
    const known = new Set(proposals.filter((p) => p.active).map((p) => `${payloadOf(p).page_key}#l${payloadOf(p).i}`));
    return hDecisionsFileProblems(content, sourceOf(batch).batch_id, known);
  },
};
