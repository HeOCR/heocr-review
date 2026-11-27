/** JSON shapes shared by the Worker API and the frontend. */
import type { AttentionRun } from "./attention";
import type { Box, ImageView } from "./media";

export interface ConfigResponse {
  environment: string;
  googleClientId: string | null;
  devAuth: boolean;
  termsVersion: string;
  termsStatus: string;
  contributorEnabled?: boolean;
}

export interface MeResponse {
  reviewerId: string;
  termsVersion: string | null;
  termsCurrent: boolean;
  displayName: string | null;
  isAdmin: boolean;
  contributorWriter?: boolean;
}

export interface Label {
  he: string;
  en: string;
}

/** The view a frontend renderer draws. Each task type maps its proposals to one view kind. */
export interface TextCorrectionView {
  kind: "text_correction";
  current: string;
  proposed: string;
  contextBefore: string;
  contextAfter: string;
  note: string;
  category: { id: string; label: Label };
  confidence: { id: string; label: Label };
  crop: ImageView | null;
  page: ImageView | null;
}

/** One printed line and a human transcription of it (task type line_verify). */
export interface LineVerifyView {
  kind: "line_verify";
  /**
   * "verify": judge the candidate against the line. "type": a blind second pass, typed from a blank box; the
   * candidate is never sent (candidate is "" and runs is empty), and the decision is final.
   */
  mode: "verify" | "type";
  /** 2: the blind second pass (final once saved). */
  pass: 1 | 2;
  /** "type": a v1.2 typed line (no candidate, either pass); "verify": an edition candidate's line. */
  lineKind: "verify" | "type";
  /**
   * In "type" mode, the typing box starts with `candidate` when this is true: a model's draft of a typed line (items
   * v1.3, pass 1 only), for the reviewer to check letter by letter. Otherwise "type" mode sends no candidate.
   */
  draft: boolean;
  /** Restricted review of a pinned draft using the normal correction diff. */
  draftVerification?: boolean;
  candidate: string;
  /** The candidate split into runs; attention runs are where the OCR engines disagree with it. */
  runs: AttentionRun[];
  lineIndex: number;
  provenance: { id: string; label: Label };
  source: { id: string; label: Label };
  bookTitle: string;
  pageLabel: string;
  attribution: string;
  textLicense: string;
  /** The page's typeface (v1.1 batches): Rashi script is its own stratum. */
  script: { id: string; label: Label } | null;
  /**
   * The agent pre-check thinks the candidate is likely wrong, and why (pass 1 of a flagged v1.1 line). Only where to
   * look: it never proposes a text. A flagged line is not marked exact before the full page has been looked at.
   */
  precheck: { reasons: { id: string; label: Label }[] } | null;
  /** The context band (about one line above and below) with the line's ink box. */
  crop: ImageView | null;
  /** The reduced full page with the line's ink box. */
  page: ImageView | null;
}

/** A held-out review response carries only the sealed reference and protected crop. */
export interface ProofreadLineView {
  kind: "reference_proofread";
  candidate: string;
  crop: ImageView | null;
}

/** One pre-fill line of a page under review, with its "look here" flags (never a proposed correction). */
export interface PageReviewLine {
  /** Index into the pre-fill's lines (blank lines counted, not shown). */
  i: number;
  text: string;
  /** Must look: the letters disagree with an independent reading, or the line has digits or brackets. */
  tierA: boolean;
  /** The line has digits or brackets, which the OCR layer may have reordered or mirrored. */
  bidiRisk: boolean;
  /** The letters disagree with an independent stock-OCR reading. */
  mismatch: boolean;
  /** Must look: Claude's own reading of the scan differs here (a hint only: its text is never shown). */
  aiDisagrees: boolean;
  /** Must look: Claude sees text next to this line that the pre-fill lacks (e.g. a margin note). */
  aiMissingNear: boolean;
}

/** A whole printed page and a pre-filled transcription of it, corrected line by line (task type page_review). */
export interface PageReviewView {
  kind: "page_review";
  unitId: string;
  pageNumber: number;
  series: { id: string; label: Label };
  period: string;
  pass: 1 | 2;
  prefillSource: string;
  prefillFromStock: boolean;
  prefillSha256: string;
  readingOrderCheck: boolean;
  lines: PageReviewLine[];
  /** The hash of Claude's hints on this page, sent back with the decision; null when it shows none (always on pass 2). */
  aiFlagsSha256: string | null;
  rejectReasons: { value: string; label: Label }[];
  attribution: string;
  textLicense: string;
  /** The page at reading resolution. */
  page: ImageView | null;
}

/** One line of a volunteer line review (task type line_consensus): the crop, the pre-fill and the "look here" hints. */
export interface LineConsensusView {
  kind: "line_consensus";
  /** The pre-fill line shown (the registered line; never AI or vendor text). */
  prefill: string;
  tierA: boolean;
  bidiRisk: boolean;
  /** Claude's hints for this line (eval's registered ai_flags.json): where to look, never a reading. */
  aiDisagrees: boolean;
  aiMissingNear: boolean;
  series: { id: string; label: Label };
  attribution: string;
  textLicense: string;
  /** The page image with the line's box, from which the browser cuts the line; null for a line with no box. */
  crop: ImageView | null;
  /** The band around the line (a little more than a line above and below), as fractions of the page. */
  context: Box | null;
  /** The whole page, with the line's box. */
  page: ImageView | null;
}

export type ProposalViewBody = TextCorrectionView | LineVerifyView | ProofreadLineView | PageReviewView | LineConsensusView;

export interface DecisionOption {
  value: string;
  label: Label;
  /** True when the decision carries the reviewer's own text (prefilled with the proposal). */
  withText: boolean;
}

export interface ProposalView {
  id: number;
  batchId: string;
  externalId: string;
  itemTitle: string;
  view: ProposalViewBody;
  options: DecisionOption[];
  /** Every line in this review mode uses the extracted draft. Echo on save to reject stale pre-rollout views. */
  pageSweepDraft?: true;
  mine: { value: string; text: string | null; decidedAt: string } | null;
  /** page_review: the reviewer's saved unsaved-corrections for this pre-fill (none once they decided the page). */
  draft?: PageDraft | null;
}

/** One line of a draft: as the decision will record it, plus whether the reviewer has looked at it. */
export interface PageDraftRow {
  src: number[];
  action: string;
  /** null: the pre-fill line's text (an unchanged or excluded line). */
  text: string | null;
  looked: boolean;
}

export interface PageDraft {
  prefillSha256: string;
  readingOrder: boolean;
  rows: PageDraftRow[];
  savedAt: string;
}

export interface Progress {
  total: number;
  /** Proposals that have reached the batch's reviewer target. */
  covered: number;
  minReviewers: number;
  decidedByMe: number;
  skippedByMe: number;
  /** Proposals still open to this reviewer (not decided by them, not skipped, below the target). */
  remainingForMe: number;
  /**
   * Volunteer batches (line_consensus): only the reviewer's own count is real. total, covered and remainingForMe
   * are 0, so nothing about other volunteers' work is shown.
   */
  ownOnly?: boolean;
}

export interface BatchSummary {
  pageSweep?: { remainingPages: number };
  referenceTyping?: true;
  realismMode?: "ranking";
  id: string;
  taskType: string;
  taskLabel: Label;
  title: string;
  progress: Progress;
  /** Subsets the reviewer can filter the queue to (e.g. an interim eval set); size = its number of pages to serve. */
  subsets: { id: string; title: string; size: number }[];
  /** A triage batch (migrations/0012_triage.sql): how many lines each of my two queues still holds. */
  triage?: { triage: number; fix: number };
}

export interface NextResponse {
  proposal: ProposalView | null;
  progress: Progress;
  prefetch: string[];
  /** A triage batch (migrations/0012_triage.sql): which queue this is, and how many lines each still holds for me. */
  triage?: { queue: "triage" | "fix"; triage: number; fix: number };
  /** A completeness check or missing-line task served in place of a line (0014). */
  page?: PageCheckView | null;
}

/** One of a page's line boxes, in page fractions. */
export interface PageLineBox {
  box: Box;
  lineIndex: number;
}

/**
 * Page completeness (migrations/0014_page_completeness.sql): "check", the page with all its boxes and the question
 * whether every printed line is boxed; "add" (desktop), the same page where the reviewer boxes and types the missing
 * lines (`added`, theirs so far).
 */
export interface PageCheckView {
  batchId: string;
  itemId: number;
  pageId: string;
  title: string;
  mode: "check" | "add";
  proofread?: boolean;
  image: ImageView | null;
  boxes: PageLineBox[];
  added: { id: string; box: Box; text: string | null; value: "typed" | "unreadable" }[];
}

export interface DecisionRequest {
  value: string;
  text?: string;
}

export interface ApiError {
  error: string;
  message?: string;
}
