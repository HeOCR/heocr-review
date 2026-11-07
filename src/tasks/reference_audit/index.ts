/**
 * Task type `reference_audit` (E2d4): an agent proposed a correction of a Wikisource reference text; a human
 * accepts it, rejects it, or edits it against the scan. The export is hocrgen's reference_audit_decisions.v1.
 */
import type { DecisionOption, Label, TextCorrectionView } from "../../shared/api";
import type { Box } from "../../shared/media";
import { imageUrl } from "../../shared/media";
import type { BatchRecord, ExportFile, NormalizedDecision, ProposalRecord, ResolvedProposal, StoredImage, TaskType } from "../types";
import { textProblem } from "../types";
import { DECISIONS_SCHEMA, decisionId, decisionsFileProblems, type RaDecision } from "./schema";

export const TASK_TYPE_ID = "reference_audit";

/** What the importer stores per proposal (proposals.payload_json). */
export interface ReferenceAuditPayload {
  start: number;
  end: number;
  current: string;
  proposed: string;
  context_before: string;
  context_after: string;
  note: string;
  page_box: Box;
  /** Position in the proposals file, so the export keeps hocrgen's order. */
  order: number;
}

/** What the importer stores per batch (batches.source_json). */
export interface ReferenceAuditSource {
  schema_version: string;
  audit_id: string;
  decisions_description: string;
  text_license: string | null;
  checker: string;
  proposed_at: string;
}

/** hocrgen's committed description (docs/reference_audit_decisions.json, commit 0d2af02). */
export const DECISIONS_DESCRIPTION =
  "E2d4: human decisions on the reference audit proposals in docs/reference_audit_proposals.json. Each decision is " +
  "accepted (apply the proposed text), rejected (keep the reference) or edited (apply the reviewer's own text for the " +
  "same span); it names its reviewer by a pseudonymous id (rv_ and 8 lower-case letters or digits, never a real name), " +
  "the date, and checked_by human. Several reviewers may decide one proposal, one decision each (decision_id " +
  "decision:<proposal_id>:<reviewer>); a proposal applies when at least min_reviewers reviewers decided it and all " +
  "agree (min_reviewers is 1 for now), and every applied outcome records its reviewer_count. Only these decisions " +
  "change a reference; an agent never writes here. Empty until a human reviews.";

export const CATEGORY_LABELS: Record<string, Label> = {
  letter_confusion: { he: "בלבול אותיות", en: "Letter confusion" },
  word_join_split: { he: "חיבור או פיצול מילים", en: "Word join/split" },
  punctuation: { he: "פיסוק", en: "Punctuation" },
  spacing: { he: "רווחים", en: "Spacing" },
  missing_text: { he: "טקסט חסר", en: "Missing text" },
  extra_text: { he: "טקסט עודף", en: "Extra text" },
  unprinted_editors_text: { he: "תוספת עורכים שאינה בדפוס", en: "Editors' text not in print" },
};

export const CONFIDENCE_LABELS: Record<string, Label> = {
  high: { he: "גבוהה", en: "High" },
  medium: { he: "בינונית", en: "Medium" },
  low: { he: "נמוכה", en: "Low" },
};

/**
 * Serving order: most informative first. The categories that need a real reading of the scan (a confused letter,
 * text the reference has but the print does not, text the print has but the reference lacks, a word joined or
 * split, editors' additions) come before punctuation, and spacing comes last: the maintainer's first 103 decisions
 * were all "space before punctuation", which hocrgen now fixes by rule (fix_space_before_punctuation). Within a
 * category, lower agent confidence comes first, since that is where a human judgement adds the most.
 */
export const CATEGORY_PRIORITY: Record<string, number> = {
  letter_confusion: 0,
  extra_text: 1,
  missing_text: 2,
  word_join_split: 3,
  unprinted_editors_text: 4,
  punctuation: 5,
  spacing: 6,
};
export const CONFIDENCE_PRIORITY: Record<string, number> = { low: 0, medium: 1, high: 2 };

const OPTIONS: DecisionOption[] = [
  { value: "accepted", label: { he: "קבלה", en: "Accept" }, withText: false },
  { value: "rejected", label: { he: "דחייה", en: "Reject" }, withText: false },
  { value: "edited", label: { he: "עריכה", en: "Edit" }, withText: true },
];

function payloadOf(p: ProposalRecord): ReferenceAuditPayload {
  return p.payload as unknown as ReferenceAuditPayload;
}

function imageView(img: StoredImage | undefined) {
  return img ? { url: imageUrl(img.ref), width: img.width, height: img.height, box: img.box, outlined: img.outlined === true } : null;
}

function sourceOf(batch: BatchRecord): ReferenceAuditSource {
  return batch.source as unknown as ReferenceAuditSource;
}

export const referenceAudit: TaskType = {
  id: TASK_TYPE_ID,
  label: { he: "בדיקת טקסט ייחוס מול הסריקה", en: "Reference audit" },
  options: OPTIONS,

  toView(p: ProposalRecord): TextCorrectionView {
    const x = payloadOf(p);
    return {
      kind: "text_correction",
      current: x.current,
      proposed: x.proposed,
      contextBefore: x.context_before,
      contextAfter: x.context_after,
      note: x.note,
      category: { id: p.category, label: CATEGORY_LABELS[p.category] ?? { he: p.category, en: p.category } },
      confidence: { id: p.confidence, label: CONFIDENCE_LABELS[p.confidence] ?? { he: p.confidence, en: p.confidence } },
      crop: imageView(p.media.crop),
      page: imageView(p.media.page),
    };
  },

  normalizeDecision(p: ProposalRecord, value: string, text: unknown): NormalizedDecision {
    const x = payloadOf(p);
    if (value === "accepted" || value === "rejected") {
      if (text !== undefined && text !== null) return { ok: false, error: "only an edited decision carries text" };
      return { ok: true, value, text: null };
    }
    if (value !== "edited") return { ok: false, error: "decision must be accepted, rejected or edited" };
    const problem = textProblem(text);
    if (problem) return { ok: false, error: problem };
    const edited = text as string;
    // hocrgen: an edit equal to the current text is a rejection; one equal to the proposal is an acceptance.
    if (edited === x.current) return { ok: true, value: "rejected", text: null };
    if (edited === x.proposed) return { ok: true, value: "accepted", text: null };
    return { ok: true, value: "edited", text: edited };
  },

  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[]): ExportFile {
    const source = sourceOf(batch);
    const decisions: RaDecision[] = resolved
      .slice()
      .sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order)
      .flatMap((r) =>
        r.current
          .slice()
          .sort((a, b) => a.reviewerId.localeCompare(b.reviewerId))
          .map((d): RaDecision => {
            // hocrgen's key order; text only for edited.
            const head = {
              decision_id: decisionId(r.proposal.externalId, d.reviewerId),
              proposal_id: r.proposal.externalId,
              item_id: r.proposal.itemExternalId,
              decision: d.value as RaDecision["decision"],
            };
            const tail = { checked_by: "human" as const, reviewer: d.reviewerId, decided_at: d.decidedOn };
            return d.value === "edited" ? { ...head, text: d.text ?? "", ...tail } : { ...head, ...tail };
          }),
      );
    return {
      fileName: "reference_audit_decisions.json",
      content: {
        schema_version: DECISIONS_SCHEMA,
        audit_id: source.audit_id,
        description: source.decisions_description || DECISIONS_DESCRIPTION,
        decisions,
      },
    };
  },

  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[] {
    const refs = proposals
      .filter((p) => p.active)
      .map((p) => ({ proposal_id: p.externalId, item_id: p.itemExternalId, current: payloadOf(p).current }));
    return decisionsFileProblems(content, sourceOf(batch).audit_id, refs);
  },
};
