/** JSON shapes shared by the Worker API and the frontend. */
import type { AttentionRun } from "./attention";
import type { ImageView } from "./media";

export interface ConfigResponse {
  environment: string;
  googleClientId: string | null;
  devAuth: boolean;
  termsVersion: string;
  termsStatus: string;
}

export interface MeResponse {
  reviewerId: string;
  termsVersion: string | null;
  termsCurrent: boolean;
  displayName: string | null;
  isAdmin: boolean;
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
  /** The context band (about one line above and below) with the line's ink box. */
  crop: ImageView | null;
  /** The reduced full page with the line's ink box. */
  page: ImageView | null;
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

export type ProposalViewBody = TextCorrectionView | LineVerifyView | PageReviewView;

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
  mine: { value: string; text: string | null; decidedAt: string } | null;
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
}

export interface BatchSummary {
  id: string;
  taskType: string;
  taskLabel: Label;
  title: string;
  progress: Progress;
}

export interface NextResponse {
  proposal: ProposalView | null;
  progress: Progress;
  prefetch: string[];
}

export interface DecisionRequest {
  value: string;
  text?: string;
}

export interface ApiError {
  error: string;
  message?: string;
}
