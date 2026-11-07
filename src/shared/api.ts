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

export type ProposalViewBody = TextCorrectionView | LineVerifyView;

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
