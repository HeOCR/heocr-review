/**
 * Task type `line_consensus`: community volunteers review the mid-century pages one printed line at a time (the line
 * crop, the page around it on request, the registered pre-fill) and mark it correct, edit it, or mark it print has
 * niqqud, unreadable or not on the page. Each line goes to two volunteers who never see each other's decision; a
 * disagreement sends that line alone to a third; three different answers send it to the maintainer, who decides it
 * blind to the volunteers' texts. Gold lines (a known answer, from pages volunteers are never given) are mixed in at
 * eval's rate and decide who counts (consensus.ts). The export is line_consensus_decisions.v0.
 *
 * Generic model mapping: a page is an item, a line is a proposal (category = the page's series, confidence = its box
 * status), the rank is the line's position (pages in line_items_v1.json order, then line index). Decisions are final:
 * one per reviewer per line, so `current` is every decision.
 */
import type { DecisionOption, Label, LineConsensusView } from "../../shared/api";
import { imageUrl } from "../../shared/media";
import { hasNiqqud } from "../../shared/niqqud";
import { SERIES_LABELS } from "../page_review/index";
import { lineTextProblems } from "../page_review/schema";
import type { BatchRecord, DecisionRecord, ExportFile, ExportExtra, NormalizedDecision, ProposalRecord, ResolvedProposal, StoredImage, TaskType } from "../types";
import {
  GOLD_FLOOR,
  GOLD_MIN,
  LINE_ACTIONS,
  goldHit,
  lineState,
  notCountedReason,
  standing,
  value,
  type LineAction,
  type LineDecision,
  type LineState,
  type Standing,
  type Vote,
} from "./consensus";
import { AGREEMENT_PY_SHA256, DECISIONS_SCHEMA, decisionsFileProblems, type DecisionsFile, type ExportDecision, type ExportLine, type ExportReviewer } from "./schema";

export const TASK_TYPE_ID = "line_consensus";

/** What the importer stores per line (proposals.payload_json). The gold answer never reaches the browser. */
export interface LineConsensusPayload {
  page_key: string;
  i: number;
  /** The pre-fill shown: the registered line, or on a gold line the line with its planted error. */
  prefill: string;
  box_status: string;
  tier_a: boolean;
  bidi_risk: boolean;
  match: number | null;
  /** Claude's hints (ai_flags.json) for this line; null when its page has no entry. */
  ai_flagged: boolean | null;
  ai_missing_near: boolean | null;
  series: string;
  prefill_source: string;
  prefill_from_stock: boolean;
  image_sha256: string;
  order: number;
  gold: null | { gold_id: string; answer: LineDecision; planted_error: null | { kind: string; from: string; to: string } };
}

/** What the importer stores per batch (batches.source_json). */
export interface LineConsensusSource {
  schema_version: string;
  batch_id: string;
  /** sha256 of each registered input (line_items_v1.json, the exclusions, gold_v1.json, agreement.py). */
  sources: Record<string, string | null>;
  /** The pages the maintainer had confirmed or rejected at import, kept out, and the export they come from. */
  maintainer_decided_excluded: { exported_at: string; pages: string[] };
}

export const payloadOf = (p: ProposalRecord): LineConsensusPayload => p.payload as unknown as LineConsensusPayload;
const sourceOf = (batch: BatchRecord): LineConsensusSource => batch.source as unknown as LineConsensusSource;
export const isGold = (p: ProposalRecord) => payloadOf(p).gold !== null;
export const hasBox = (p: ProposalRecord) => payloadOf(p).box_status === "matched" || payloadOf(p).box_status === "fuzzy";

const OPTIONS: DecisionOption[] = [
  { value: "correct", label: { he: "נכון", en: "Correct" }, withText: false },
  { value: "edit", label: { he: "תיקון", en: "Edit" }, withText: true },
  { value: "print_has_niqqud", label: { he: "בדפוס יש ניקוד", en: "Print has niqqud" }, withText: true },
  { value: "unreadable", label: { he: "לא קריא", en: "Unreadable" }, withText: false },
  { value: "not_on_page", label: { he: "לא בעמוד", en: "Not on the page" }, withText: false },
];

const ATTRIBUTION: Record<string, string> = {
  sefer_hachukim: "רשומות, מדינת ישראל / Reshumot, the official gazette of the State of Israel",
  kovetz_hatakanot: "רשומות, מדינת ישראל / Reshumot, the official gazette of the State of Israel",
  plenary: "דברי הכנסת, הכנסת / The Knesset's plenary record",
};
const TEXT_LICENSE = "Public domain in Israel (Copyright Act 2007, §6)";

function imageView(img: StoredImage | undefined) {
  return img ? { url: imageUrl(img.ref), width: img.width, height: img.height, box: img.box, outlined: img.outlined === true } : null;
}

/**
 * A decision as stored: value is the action; text the final text for edit and print_has_niqqud (NFC, trimmed), null
 * otherwise. An edit equal to the pre-fill is recorded as correct (the same statement under §3). A print_has_niqqud
 * text holds the letters only; without one it is the pre-fill's.
 */
export function normalizeLineDecision(prefill: string, action: string, text: unknown): NormalizedDecision {
  if (!(LINE_ACTIONS as readonly string[]).includes(action)) return { ok: false, error: `decision must be one of ${LINE_ACTIONS.join(", ")}` };
  if (action === "correct" || action === "unreadable" || action === "not_on_page") {
    if (text !== undefined && text !== null) return { ok: false, error: `a line marked ${action} carries no text` };
    return { ok: true, value: action, text: null };
  }
  if (action === "print_has_niqqud" && (text === undefined || text === null)) return { ok: true, value: action, text: prefill.normalize("NFC").trim() };
  if (typeof text !== "string") return { ok: false, error: "type the line's text" };
  const typed = text.normalize("NFC").trim();
  const problems = lineTextProblems(typed);
  if (problems.length) return { ok: false, error: `the text ${problems.join("; ")}` };
  if (action === "print_has_niqqud" && hasNiqqud(typed)) return { ok: false, error: "type the letters only, without niqqud" };
  if (action === "edit" && typed === prefill.normalize("NFC").trim()) return { ok: true, value: "correct", text: null };
  return { ok: true, value: action, text: typed };
}

const asLine = (d: { value: string; text: string | null }): LineDecision => ({ action: d.value as LineAction, text: d.text });

// ---------------------------------------------------------------------------------------------------------------
// Standing and routing, shared by the Worker (routing) and the export

export interface StandingRow extends Standing {
  plantedSeen: number;
  plantedHits: number;
}

/** Every volunteer's standing from their gold decisions (graded with agreement.gold_hit) and the admin switch. */
export function standingsOf(goldDecisions: { reviewerId: string; value: string; text: string | null; proposal: ProposalRecord }[], excluded: Set<string>): Map<string, StandingRow> {
  const tally = new Map<string, { graded: number; hits: number; plantedSeen: number; plantedHits: number }>();
  for (const d of goldDecisions) {
    const x = payloadOf(d.proposal);
    if (!x.gold) continue;
    const t = tally.get(d.reviewerId) ?? { graded: 0, hits: 0, plantedSeen: 0, plantedHits: 0 };
    const hit = goldHit(asLine(d), x.gold.answer, x.prefill);
    t.graded++;
    if (hit) t.hits++;
    if (x.gold.planted_error) {
      t.plantedSeen++;
      if (hit) t.plantedHits++;
    }
    tally.set(d.reviewerId, t);
  }
  const out = new Map<string, StandingRow>();
  for (const id of new Set([...tally.keys(), ...excluded])) {
    const t = tally.get(id) ?? { graded: 0, hits: 0, plantedSeen: 0, plantedHits: 0 };
    out.set(id, { ...standing(t.graded, t.hits, excluded.has(id)), plantedSeen: t.plantedSeen, plantedHits: t.plantedHits });
  }
  return out;
}

export const standingOf = (s: Map<string, StandingRow>, id: string): StandingRow => s.get(id) ?? { ...standing(0, 0, false), plantedSeen: 0, plantedHits: 0 };

export type Routed =
  | LineState
  /** No box: the line goes to the maintainer without volunteers. */
  | { state: "no_box"; needed: 0 }
  /** The maintainer decided a line that was theirs to decide. */
  | { state: "maintainer"; needed: 0 };

/**
 * A real line's state: from its volunteers' decisions (the maintainer's own, if any, decides a line that went to
 * them). `volunteers` excludes the maintainer's decisions.
 */
export function routeLine(p: ProposalRecord, volunteers: { reviewerId: string; value: string; text: string | null; at: string }[], maintainer: boolean, standings: Map<string, StandingRow>): Routed {
  if (!hasBox(p)) return maintainer ? { state: "maintainer", needed: 0 } : { state: "no_box", needed: 0 };
  const votes: Vote[] = volunteers.map((d) => ({ ...asLine(d), reviewerId: d.reviewerId, at: d.at, standing: standingOf(standings, d.reviewerId).state }));
  const s = lineState(votes, payloadOf(p).prefill);
  if (s.state === "to_maintainer" && maintainer) return { state: "maintainer", needed: 0 };
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// The export

function exportFile(batch: BatchRecord, resolved: ResolvedProposal[], extra: ExportExtra): DecisionsFile {
  const src = sourceOf(batch);
  const maintainer = new Set(extra.maintainerDecisions);
  const excluded = new Map(extra.exclusions.map((e) => [e.reviewerId, e.excludedAt]));
  const all = resolved.flatMap((r) => r.current.map((d) => ({ d, p: r.proposal })));
  const gold = all.filter(({ p }) => isGold(p)).map(({ d, p }) => ({ reviewerId: d.reviewerId, value: d.value, text: d.text, proposal: p }));
  const standings = standingsOf(gold, new Set(excluded.keys()));
  const decisions: ExportDecision[] = [];
  const lines: ExportLine[] = [];
  const flagsOf = (x: LineConsensusPayload) => ({ tier_a: x.tier_a, ai_flagged: x.ai_flagged, ai_missing_near: x.ai_missing_near });
  const textOf = (x: LineConsensusPayload, d: DecisionRecord) => (d.value === "correct" ? x.prefill : d.text);
  const sorted = resolved.slice().sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order);
  for (const r of sorted) {
    const x = payloadOf(r.proposal);
    const ds = r.current.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.reviewerId.localeCompare(b.reviewerId));
    const base = (d: DecisionRecord) => ({
      decision_id: d.id,
      reviewer: d.reviewerId,
      page_key: x.page_key,
      i: x.i,
      action: d.value as LineAction,
      text: textOf(x, d),
      decided_at: d.createdAt,
      flags_shown: flagsOf(x),
    });
    if (x.gold) {
      for (const d of ds) {
        decisions.push({ ...base(d), role: "gold", gold_id: x.gold.gold_id, gold_hit: goldHit(asLine(d), x.gold.answer, x.prefill), counted: false, not_counted_reason: "gold_line" });
      }
      continue;
    }
    const vol = ds.filter((d) => !maintainer.has(d.id));
    const maint = ds.filter((d) => maintainer.has(d.id));
    const routed = routeLine(r.proposal, vol.map((d) => ({ reviewerId: d.reviewerId, value: d.value, text: d.text, at: d.createdAt })), maint.length > 0, standings);
    const roles = ["first", "second", "third"] as const;
    vol.forEach((d, k) => {
      const s = standingOf(standings, d.reviewerId).state;
      const reason = notCountedReason(s);
      decisions.push({ ...base(d), role: roles[k] ?? "extra", gold_id: null, gold_hit: null, counted: reason === null, not_counted_reason: reason });
    });
    for (const d of maint) decisions.push({ ...base(d), role: "maintainer", gold_id: null, gold_hit: null, counted: false, not_counted_reason: "maintainer" });
    let outcome: ExportLine["outcome"] = "pending";
    let reference: ExportLine["reference"] = null;
    if (routed.state === "agreed" || routed.state === "majority") {
      outcome = routed.state;
      const deciding = vol.filter((d) => routed.reviewers.includes(d.reviewerId));
      const counts = new Map<string, number>();
      for (const d of deciding) counts.set(value(asLine(d), x.prefill), (counts.get(value(asLine(d), x.prefill)) ?? 0) + 1);
      const ref = deciding.find((d) => (counts.get(value(asLine(d), x.prefill)) ?? 0) >= 2)!;
      reference = { action: ref.value as LineAction, text: textOf(x, ref) };
    } else if (routed.state === "maintainer") {
      outcome = "maintainer";
      const m = maint[maint.length - 1]!;
      reference = { action: m.value as LineAction, text: textOf(x, m) };
    } else if (routed.state === "to_maintainer" || routed.state === "no_box") outcome = "to_maintainer";
    lines.push({ page_key: x.page_key, i: x.i, prefill: x.prefill, box_status: x.box_status, outcome, reference, decision_ids: ds.map((d) => d.id) });
  }
  const reviewers: ExportReviewer[] = [...new Set(decisions.filter((d) => d.role !== "maintainer").map((d) => d.reviewer))].sort().map((id) => {
    const s = standingOf(standings, id);
    const mine = decisions.filter((d) => d.reviewer === id && d.role !== "gold");
    return {
      reviewer: id,
      gold_seen: s.graded,
      gold_hits: s.hits,
      planted_seen: s.plantedSeen,
      planted_hits: s.plantedHits,
      standing: s.state,
      decisions: mine.length,
      decisions_counted: mine.filter((d) => d.counted).length,
    };
  });
  return {
    schema_version: DECISIONS_SCHEMA,
    batch_id: src.batch_id,
    exported_at: extra.exportedAt,
    sources: { ...src.sources, "agreement.py": AGREEMENT_PY_SHA256 },
    maintainer_decided_excluded: src.maintainer_decided_excluded,
    rule: { floor: GOLD_FLOOR, min_gold: GOLD_MIN, agreement: "heocr-restricted-eval preregistration/midcentury_volunteers_2026-11-18/agreement.py" },
    decisions,
    lines,
    reviewers,
    admin_exclusions: [...excluded].map(([reviewer, excluded_at]) => ({ reviewer, excluded_at })).sort((a, b) => a.reviewer.localeCompare(b.reviewer)),
  };
}

export const lineConsensus: TaskType = {
  id: TASK_TYPE_ID,
  label: { he: "בדיקת שורות בידי מתנדבים", en: "Volunteer line review" },
  options: OPTIONS,
  prefetch: ["crop"],

  toView(p: ProposalRecord): LineConsensusView {
    const x = payloadOf(p);
    return {
      kind: "line_consensus",
      prefill: x.prefill,
      tierA: x.tier_a,
      bidiRisk: x.bidi_risk,
      aiDisagrees: x.ai_flagged === true,
      aiMissingNear: x.ai_missing_near === true,
      series: { id: x.series, label: (SERIES_LABELS[x.series] as Label | undefined) ?? { he: x.series, en: x.series } },
      attribution: ATTRIBUTION[x.series] ?? "",
      textLicense: TEXT_LICENSE,
      crop: imageView(p.media.crop),
      page: imageView(p.media.page),
    };
  },

  normalizeDecision(p: ProposalRecord, value: string, text: unknown): NormalizedDecision {
    return normalizeLineDecision(payloadOf(p).prefill, value, text);
  },

  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[], extra?: ExportExtra): ExportFile {
    const content = exportFile(batch, resolved, extra ?? { exportedAt: new Date(0).toISOString(), exclusions: [], maintainerDecisions: [] });
    return { fileName: "line_consensus_decisions.json", content };
  },

  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[] {
    const known = new Set(proposals.filter((p) => p.active).map((p) => `${payloadOf(p).page_key}#l${payloadOf(p).i}`));
    return decisionsFileProblems(content, sourceOf(batch).batch_id, known);
  },
};
