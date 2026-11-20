/**
 * The generic data model: task types -> batches of items -> proposals -> decisions.
 *
 * A task type (reference audit, line verification; planned: per-line language tags, second-review adjudication)
 * defines how its stored proposal payloads are shown, which decisions a reviewer can make, how a decision is
 * normalised, and how resolved decisions are written back out in the format its consumer reads. Everything
 * else (sign-in, queueing, recording every reviewer's decision, progress, export resolution) is shared.
 */
import type { DecisionOption, Label, ProposalViewBody } from "../shared/api";
import type { Box, ImageRef } from "../shared/media";

export interface StoredImage {
  ref: ImageRef;
  width: number;
  height: number;
  box: Box | null;
  /** The region is already drawn into the image (hocrgen's crop bundle); the UI does not outline it again. */
  outlined?: boolean;
}

export interface ProposalMedia {
  crop?: StoredImage;
  page?: StoredImage;
}

export interface BatchRecord {
  id: string;
  taskType: string;
  title: string;
  /** Task-type metadata about the imported file, kept for the export. */
  source: Record<string, unknown>;
  minReviewers: number;
  /** The batch's settings (migrations/0006_batch_settings.sql); absent where a record is built without them. */
  settings?: { pass2Reviewer: "same" | "other"; pass2ReviewerSetAt: string | null; twoTypingsGroups: string[]; twoTypingsSetAt: string | null; resolution: "single" | "volunteer_v1" | "volunteer_v1_1"; pointedBooks: "drop" | "keep"; mode: "standard" | "triage" };
}

export interface ProposalRecord {
  id: number;
  batchId: string;
  externalId: string;
  itemExternalId: string;
  itemTitle: string;
  category: string;
  confidence: string;
  rank: number;
  payload: Record<string, unknown>;
  media: ProposalMedia;
  contentSha256: string;
  active: boolean;
}

export interface DecisionRecord {
  id: string;
  proposalId: number;
  reviewerId: string;
  value: string;
  text: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** YYYY-MM-DD (UTC). */
  decidedOn: string;
  supersededAt: string | null;
  /** The proposal content the reviewer saw; a decision on changed content is stale and never exported. */
  proposalSha256: string;
  termsVersion: string;
}

export interface Credit {
  reviewerId: string;
  displayName: string;
  consentedAt: string;
}

export type NormalizedDecision = { ok: true; value: string; text: string | null } | { ok: false; error: string };

/**
 * One proposal with every reviewer's decisions sorted out. `current` (one per reviewer, on the content as it is now)
 * is what the export emits; `status` is the outcome under the batch's min_reviewers, the same rule the consumer
 * applies (hocrgen ReferenceAudit.outcome): agreed when at least min_reviewers current decisions all agree.
 */
export interface ResolvedProposal {
  proposal: ProposalRecord;
  status: "undecided" | "awaiting_reviewers" | "agreed" | "conflict";
  current: DecisionRecord[];
  stale: DecisionRecord[];
  superseded: DecisionRecord[];
}

export interface ExportFile {
  fileName: string;
  content: unknown;
}

/** What an export may need beyond the decisions (line_consensus: who is excluded, which are maintainer decisions). */
export interface ExportExtra {
  exportedAt: string;
  exclusions: { reviewerId: string; excludedAt: string }[];
  /** Ids of decisions an admin made in a volunteer batch (migrations/0005_line_consensus.sql). */
  maintainerDecisions: string[];
  /** line_verify volunteer_v1: what each decision recorded when it was made (migrations/0009). */
  verifyVotes?: VerifyVote[];
  /** line_verify volunteer_v1_1: each gold decision's grade, and the gold lines pulled now (migrations/0010). */
  phistGold?: { grades: PhistGoldGrade[]; pulled: string[] };
  /** line_verify: the pointed-book rule's drops, per triggering mark (migrations/0011). */
  pointedDrops?: PointedDrop[];
  /** line_verify triage: the batch's planted errors (migrations/0012_triage.sql). */
  triagePlants?: { proposalId: number; plantType: string; plantedSha256: string; candidateSha256: string }[];
  /** line_verify triage: page checks and added lines (migrations/0014_page_completeness.sql). */
  triagePages?: TriagePages;
}

export interface PointedDrop {
  decisionId: string;
  reviewerId: string | null;
  triggerItem: string | null;
  bookId: string;
  lines: number;
  restored: number;
  droppedAt: string;
}

export interface PhistGoldGrade {
  decisionId: string;
  goldId: string;
  hit: boolean;
}

export interface VerifyVote {
  decisionId: string;
  counted: boolean;
  notCountedReason: string | null;
  step: string;
  byAdmin: boolean;
}

export interface TaskType {
  id: string;
  label: Label;
  options: DecisionOption[];
  /** The options of one proposal, when they differ from `options` (line_verify's blind second pass). */
  optionsFor?(proposal: ProposalRecord): DecisionOption[];
  /** A reviewer's decision on this proposal is final: it cannot be changed (line_verify's blind second pass). */
  finalDecision?(proposal: ProposalRecord): boolean;
  /** Which of the next proposals' images the browser fetches ahead (default: crop and page). */
  prefetch?: (keyof ProposalMedia)[];
  toView(proposal: ProposalRecord): ProposalViewBody;
  normalizeDecision(proposal: ProposalRecord, value: string, text: unknown): NormalizedDecision;
  /** The consumer's decisions file, built from the resolved proposals. */
  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[], extra?: ExportExtra): ExportFile;
  /** Further admin export files, beside the decisions and the ledger (line_verify triage: reference_triage.json). */
  exportExtraFiles?(batch: BatchRecord, resolved: ResolvedProposal[], exportedAt: string, extra?: ExportExtra): ExportFile[];
  /** Problems with an exported decisions file (empty when valid), checked against the batch's proposals. */
  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[];
}

export const MAX_TEXT_LENGTH = 1000;

/** Control characters other than tab and line feed are never valid in reviewer text. */
const BAD_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function textProblem(text: unknown): string | null {
  if (typeof text !== "string") return "text must be a string";
  if (text.length > MAX_TEXT_LENGTH) return `text must be at most ${MAX_TEXT_LENGTH} characters`;
  if (BAD_CONTROL.test(text)) return "text must not contain control characters";
  return null;
}

/** A triage batch's page records for the export (migrations/0014_page_completeness.sql). */
export interface TriagePages {
  checks: { pageId: string; reviewerId: string; answer: "complete" | "missing_lines" | "lines_added"; decidedOn: string; missingOn: string | null }[];
  added: { id: string; pageId: string; reviewerId: string; box: [number, number, number, number]; text: string | null; value: "typed" | "unreadable"; decidedOn: string }[];
}
