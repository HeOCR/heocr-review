/** JSON shapes shared by the Worker API and the frontend. */
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

export type ProposalViewBody = TextCorrectionView;

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
