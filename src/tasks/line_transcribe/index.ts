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
 * - no gold in this batch: who counts is the volunteer's standing in the mid-century volunteer batch (GATE_BATCH_ID),
 *   and only counting volunteers and the maintainer are served at all;
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
  GATE_BATCH_ID,
  H_ACTIONS,
  H_DECISIONS_SCHEMA,
  LANGUAGE_LABELS,
  SPAN_MARKER,
  hDecisionsFileProblems,
  type HAction,
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
  hand_id: string;
  attribution: string;
  license_expression: string;
  image_sha256: string;
  order: number;
  page_box: Box;
  context_box: Box;
}

export interface LineTranscribeSource {
  schema_version: string;
  batch_id: string;
  gate_batch_id: string;
  sources: Record<string, string | null>;
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
  { value: "not_on_page", label: { he: "המסגרת לא מכילה שורה אחת", en: "Box doesn't hold one line" }, withText: false },
];

const TEXT_LICENSE = "Transcriptions: CC0 1.0. Image: the scan's own terms (public domain).";

function imageView(img: StoredImage | undefined) {
  return img ? { url: imageUrl(img.ref), width: img.width, height: img.height, box: img.box, outlined: img.outlined === true } : null;
}

/**
 * A transcription as stored: edit and print_has_niqqud carry the typed text (NFC, trimmed; never empty);
 * print_has_niqqud's text has the letters only. There is no `correct`: nothing was shown to confirm.
 */
export function normalizeTranscription(action: string, text: unknown): NormalizedDecision {
  if (!(H_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: `decision must be one of ${H_ACTIONS.join(", ")}` };
  if (action === "unreadable" || action === "not_on_page") {
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

const asLine = (d: { value: string; text: string | null }) => ({ action: d.value as LineAction, text: d.text });

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
    const base = (d: DecisionRecord) => ({ decision_id: d.id, reviewer: d.reviewerId, page_key: x.page_key, i: x.i, action: d.value as HAction, text: d.text, decided_at: d.createdAt });
    const vol = ds.filter((d) => !maintainer.has(d.id));
    const maint = ds.filter((d) => maintainer.has(d.id));
    const routed = routeLine(r.proposal, vol.map((d) => ({ reviewerId: d.reviewerId, value: d.value, text: d.text, at: d.createdAt })), maint.length > 0, standings);
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
      reference = { action: ref.value as HAction, text: ref.text };
    } else if (routed.state === "maintainer") {
      outcome = "maintainer";
      const m = maint[maint.length - 1]!;
      reference = { action: m.value as HAction, text: m.text };
    } else if (routed.state === "to_maintainer") outcome = "to_maintainer";
    const tally = (strata[x.stratum] ??= {});
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    lines.push({ page_key: x.page_key, i: x.i, eval_set: x.eval_set, stratum: x.stratum, languages: x.languages, hand_id: x.hand_id, outcome, reference, decision_ids: ds.map((d) => d.id) });
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
