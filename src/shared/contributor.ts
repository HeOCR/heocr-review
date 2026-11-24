export const CONTRIBUTOR_API = "/api/contributor/v1";
export const contributorKinds = ["print", "form", "line", "handwriting"] as const;
export type ContributorKind = typeof contributorKinds[number];
export const captureModes = ["flat", "angle", "shadow", "crumpled", "scribbled", "folded"] as const;
export type CaptureMode = typeof captureModes[number];
export const requiredPrintModes = ["flat", "angle", "folded", "crumpled", "scribbled"] as const;
export type PrintCaptureStep = { mode: CaptureMode; saved: boolean };
export type ContributorSplit = "train" | "dev" | "eval_open";
export const ageBands = ["10_12", "13_15", "16_17"] as const;
export type AgeBand = typeof ageBands[number];
export type Language = "he" | "en";
export type ConsentCopy = { text: string; sha256: string };
export type FormField = { id: string; label: string; value: string };

export type ContributorNext = {
  id: string;
  kind: ContributorKind;
  page: string;
} & (
  { kind: "print"; mode: CaptureMode; sheet: string; captureSteps?: PrintCaptureStep[]; variant?: "kids" } |
  { kind: "form"; sheet: string; fields: FormField[]; referenceSha256: string } |
  { kind: "line"; crop: string; candidate: string } |
  { kind: "handwriting"; prompt: string; rights: string; referenceSha256: string }
);

export type PrintCapture = Extract<ContributorNext, { kind: "print" }>;
export type ContributorQueue = { kind: ContributorKind; done: number; total: number; next: ContributorNext | null; optionalPrint?: PrintCapture[] };
export type ContributorProfile = {
  role: "writer" | "guardian";
  writer: string;
  ageBand: AgeBand;
  state: "guardian" | "assent" | "ready" | "withdrawn";
  receipt: string | null;
  licence: "cc0_open";
  version: string;
  copy: Record<Language, ConsentCopy>;
  queues: ContributorQueue[];
};
