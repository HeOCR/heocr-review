/**
 * Task type `page_review`: a human reads one whole printed page (a scan) next to a pre-filled transcription (the
 * PDF's own OCR layer, or stock Tesseract; never a HeOCR model), corrects it line by line and confirms that the lines,
 * as corrected, are the page's text in reading order, or rejects the page. Lines flagged tier A ("look here") must
 * each be looked at; the flags never propose a correction. The export is page_review_decisions.v0, which eval's
 * ingest reads.
 *
 * Generic model mapping: a page is an item; a page pass is a proposal (category = stratum, confidence = role). The
 * decision's value is confirm or reject and its text the page decision as JSON (schema.ts). Reserve pages open only
 * to replace a rejected page; a blind second pass opens to a reviewer 24 hours after their own first-pass confirm of
 * the page and starts from a different pre-fill (gates: migrations/0002_proposal_gates.sql).
 */
import type { DecisionOption, Label, PageReviewView } from "../../shared/api";
import { imageUrl } from "../../shared/media";
import type { BatchRecord, DecisionRecord, ExportFile, NormalizedDecision, ProposalRecord, ResolvedProposal, StoredImage, TaskType } from "../types";
import {
  DECISIONS_SCHEMA,
  EXCLUDED_ACTIONS,
  MAX_DECISION_LENGTH,
  REJECT_REASONS,
  TEXT_ACTIONS,
  decisionIdFor,
  decisionsFileProblems,
  normalizePageDecision,
  referenceViews,
  type AiShown,
  type PageDecision,
  type PrDecision,
  type PrefillLine,
} from "./schema";

export const TASK_TYPE_ID = "page_review";
/** Below this letter agreement with the independent stock reading, eval marks a line as a mismatch. */
const MISMATCH_BELOW = 85;

/** What the importer stores per page pass (proposals.payload_json). */
export interface PageReviewPayload {
  unit_id: string;
  page: number;
  stratum: string;
  series: string;
  role: "test" | "reserve";
  pass: 1 | 2;
  blind_second_pass: boolean;
  prefill_source: string;
  prefill_from_stock: boolean;
  prefill_sha256: string;
  lines: PrefillLine[];
  reading_order_check: boolean;
  difficulty: number;
  node: string;
  image_sha256: string;
  source_pdf_sha256: string;
  /** Position in the queue (test pages in the manifest's order, then reserves, then pass 2). */
  order: number;
  /**
   * Claude's hints (ai_flags.json), first pass only; absent or null when the page has none. Deliberately not in the
   * proposal's content hash: adding hints leaves earlier decisions current. Each decision records instead which
   * hints its reviewer was shown (`ai_flags` in the decision, `ai_flagged_i` in the export). `sha256` is what the
   * browser sends back to say it showed these.
   */
  ai_flags?: (AiShown & { sha256: string }) | null;
}

/** What the importer stores per batch (batches.source_json). */
export interface PageReviewSource {
  schema_version: string;
  batch_id: string;
  split_sha256: string;
  fetch_manifest_sha256: string;
  manifest_sha256: string | null;
  blind_rule: string | null;
  /** Where the first pass's hints came from (ai_flags.json), when the batch has them. */
  ai_flags?: { schema: string; model: string; created_at: string } | null;
}

export const SERIES_LABELS: Record<string, Label> = {
  sefer_hachukim: { he: "ספר החוקים", en: "Sefer ha-Hukim (laws)" },
  kovetz_hatakanot: { he: "קובץ התקנות", en: "Kovetz ha-Takanot (regulations)" },
  plenary: { he: "דברי הכנסת", en: "Knesset plenary record" },
};

const ATTRIBUTION: Record<string, string> = {
  sefer_hachukim: "רשומות, מדינת ישראל / Reshumot, the official gazette of the State of Israel",
  kovetz_hatakanot: "רשומות, מדינת ישראל / Reshumot, the official gazette of the State of Israel",
  plenary: "דברי הכנסת, הכנסת / The Knesset's plenary record",
};
const TEXT_LICENSE = "Public domain in Israel (Copyright Act 2007, §6)";

export const REJECT_LABELS: Record<(typeof REJECT_REASONS)[number], Label> = {
  blank: { he: "עמוד ריק", en: "Blank page" },
  unreadable: { he: "לא קריא", en: "Unreadable" },
  misfetched: { he: "עמוד שגוי או חתוך", en: "Wrong or cut page" },
  other: { he: "אחר", en: "Other" },
};

const OPTIONS: DecisionOption[] = [
  { value: "confirm", label: { he: "אישור העמוד", en: "Confirm page" }, withText: true },
  { value: "reject", label: { he: "פסילת העמוד", en: "Reject page" }, withText: true },
];

export const payloadOf = (p: ProposalRecord): PageReviewPayload => p.payload as unknown as PageReviewPayload;
const sourceOf = (batch: BatchRecord): PageReviewSource => batch.source as unknown as PageReviewSource;

function imageView(img: StoredImage | undefined) {
  return img ? { url: imageUrl(img.ref), width: img.width, height: img.height, box: null, outlined: false } : null;
}

/** The hints a page shows now (never on the blind second pass). */
export const aiFlagsOf = (x: PageReviewPayload) => (x.pass === 1 ? (x.ai_flags ?? null) : null);

/**
 * The page-level fields of one stored decision, as the export writes them. `ai_flagged_i` and `ai_missing_near_i` are
 * the hints the reviewer was shown when making it (null: none, as for every decision made before hints were added).
 */
function decisionBody(x: PageReviewPayload, d: DecisionRecord) {
  const decision = JSON.parse(d.text ?? "{}") as PageDecision;
  const lines = decision.page_action === "confirm" ? decision.lines.map((l) => ({ ...l, reference_views: referenceViews(l.action) })) : [];
  return {
    page_action: decision.page_action,
    ...(decision.page_action === "reject" ? { reject_reason: decision.reject_reason, reject_note: decision.reject_note } : {}),
    reading_order_verified: decision.page_action === "confirm" ? decision.reading_order_verified : null,
    lines,
    ai_flagged_i: decision.ai_flags?.flagged_i ?? null,
    ai_missing_near_i: decision.ai_flags?.missing_near_i ?? null,
  };
}

/**
 * One record. `pass2At` is when this reviewer first decided the page's blind second pass (pass-1 records of blind
 * pages only): a pass-1 decision made after it is `revised_after_pass2`, and the record then also carries
 * `pass1_at_pass2`, the pass-1 decision that stood when pass 2 was first decided (the one the passes compare).
 */
function exportRecord(batchId: string, p: ProposalRecord, d: DecisionRecord, all: DecisionRecord[], pass2At: string | null): PrDecision {
  const x = payloadOf(p);
  const mine = all.filter((o) => o.reviewerId === d.reviewerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const body = decisionBody(x, d);
  const revised = pass2At !== null && d.createdAt > pass2At;
  const standing = revised ? mine.filter((o) => o.createdAt <= pass2At).pop() : undefined;
  return {
    decision_id: decisionIdFor(p.externalId, d.reviewerId),
    batch_id: batchId,
    unit_id: x.unit_id,
    page: x.page,
    image_sha256: x.image_sha256,
    prefill_source: x.prefill_source,
    prefill_sha256: x.prefill_sha256,
    reviewer: d.reviewerId,
    pass: x.pass,
    blind_second_pass: x.pass === 2 ? true : x.blind_second_pass,
    ...body,
    counts: {
      tier_a: x.lines.filter((l) => l.tier_a).length,
      edited: body.lines.filter((l) => TEXT_ACTIONS.includes(l.action)).length,
      excluded: body.lines.filter((l) => EXCLUDED_ACTIONS.includes(l.action)).length,
    },
    decided_at: d.createdAt,
    first_decided_at: mine[0]?.createdAt ?? d.createdAt,
    ...(pass2At !== null
      ? {
          revised_after_pass2: revised,
          ...(revised ? { pass1_at_pass2: standing ? { ...decisionBody(x, standing), decided_at: standing.createdAt } : null } : {}),
        }
      : {}),
    checked_by: "human",
  };
}

export const pageReview: TaskType = {
  id: TASK_TYPE_ID,
  label: { he: "תיקון תעתיק של עמוד שלם", en: "Whole-page transcription review" },
  options: OPTIONS,
  prefetch: ["page"],

  toView(p: ProposalRecord): PageReviewView {
    const x = payloadOf(p);
    const ai = aiFlagsOf(x);
    const flagged = new Set(ai?.flagged_i ?? []);
    const missing = new Set(ai?.missing_near_i ?? []);
    return {
      kind: "page_review",
      unitId: x.unit_id,
      pageNumber: x.page,
      series: { id: x.series, label: SERIES_LABELS[x.series] ?? { he: x.series, en: x.series } },
      period: x.stratum.split("|")[1] ?? "",
      pass: x.pass,
      prefillSource: x.prefill_source,
      prefillFromStock: x.prefill_from_stock,
      prefillSha256: x.prefill_sha256,
      readingOrderCheck: x.reading_order_check,
      lines: x.lines.map((l) => ({
        i: l.i,
        text: l.text,
        tierA: l.tier_a,
        bidiRisk: l.bidi_risk,
        mismatch: l.match !== null && l.match < MISMATCH_BELOW,
        aiDisagrees: flagged.has(l.i),
        aiMissingNear: missing.has(l.i),
      })),
      aiFlagsSha256: ai?.sha256 ?? null,
      rejectReasons: REJECT_REASONS.map((value) => ({ value, label: REJECT_LABELS[value] })),
      attribution: ATTRIBUTION[x.series] ?? "",
      textLicense: TEXT_LICENSE,
      page: imageView(p.media.page),
    };
  },

  normalizeDecision(p: ProposalRecord, value: string, text: unknown): NormalizedDecision {
    if (typeof text !== "string" || text.length > MAX_DECISION_LENGTH) return { ok: false, error: "the page decision must be JSON text" };
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return { ok: false, error: "the page decision must be JSON text" };
    }
    const x = payloadOf(p);
    const n = normalizePageDecision(x.lines, x.reading_order_check, value, input);
    if (!n.ok) return { ok: false, error: n.error };
    // Which hints the browser showed: the page's current ones (it sends their hash back), or none (a page opened
    // before they were imported). Recorded as shown, so eval can tell decisions made with and without them apart.
    const ai = aiFlagsOf(x);
    const sent = (input as Record<string, unknown>).ai_flags_sha256 ?? null;
    if (sent !== null && sent !== ai?.sha256) return { ok: false, error: "this page's hints changed since it was opened: reload the page" };
    const decision: PageDecision = sent !== null && ai ? { ...n.decision, ai_flags: { flagged_i: ai.flagged_i, missing_near_i: ai.missing_near_i } } : n.decision;
    return { ok: true, value: decision.page_action, text: JSON.stringify(decision) };
  },

  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[]): ExportFile {
    const batchId = sourceOf(batch).batch_id;
    // Per first-pass page: when each reviewer first decided its blind second pass.
    const blindByFirst = new Map<string, Map<string, string>>();
    for (const r of resolved) {
      if (payloadOf(r.proposal).pass !== 2) continue;
      const first = new Map<string, string>();
      for (const d of [...r.current, ...r.superseded, ...r.stale]) {
        const at = first.get(d.reviewerId);
        if (!at || d.createdAt < at) first.set(d.reviewerId, d.createdAt);
      }
      blindByFirst.set(r.proposal.itemExternalId, first);
    }
    const decisions = resolved
      .slice()
      .sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order)
      .flatMap((r) => {
        const all = [...r.current, ...r.superseded, ...r.stale];
        const blind = blindByFirst.get(r.proposal.externalId);
        return r.current
          .slice()
          .sort((a, b) => a.reviewerId.localeCompare(b.reviewerId))
          .map((d) => exportRecord(batchId, r.proposal, d, all, blind?.get(d.reviewerId) ?? null));
      });
    return { fileName: "page_review_decisions.json", content: { schema_version: DECISIONS_SCHEMA, batch_id: batchId, decisions } };
  },

  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[] {
    const pages = new Map(
      proposals
        .filter((p) => p.active)
        .map((p) => {
          const x = payloadOf(p);
          return [
            p.externalId,
            { unitId: x.unit_id, page: x.page, imageSha256: x.image_sha256, prefillSha256: x.prefill_sha256, pass: x.pass, shown: x.lines, readingOrderCheck: x.reading_order_check },
          ];
        }),
    );
    return decisionsFileProblems(content, sourceOf(batch).batch_id, pages);
  },
};
