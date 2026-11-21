import type { DecisionOption } from "./api";
import type { Box } from "./media";

export const PAGE_SWEEP_BATCHES = [
  "midcentury_triage_v1",
  "phist_holdout_v2_2page",
  "phist_holdout_topup_v2_2page",
] as const;

export interface SweepLine {
  id: number;
  text: string;
  box: Box | null;
  state: "open" | "pending" | "done" | "edited" | "flagged" | "skipped";
  options: DecisionOption[];
  order: number;
}

export interface SweepPage {
  id: number;
  title: string;
  image: { url: string; width: number; height: number };
  token: string;
  lines: SweepLine[];
  final: boolean;
  missing: boolean;
}
