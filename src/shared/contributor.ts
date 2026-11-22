export const CONTRIBUTOR_API = "/api/contributor/v1";
export const contributorKinds = ["print", "form", "line", "handwriting"] as const;
export type ContributorKind = typeof contributorKinds[number];
export const captureModes = ["flat", "angle", "shadow", "crumpled", "scribbled", "folded"] as const;
export type CaptureMode = typeof captureModes[number];
export type ContributorSplit = "train" | "dev" | "eval_open";
export type AgeBand = "under_13" | "13_15" | "16_17";
export type Licence = "cc0_open" | "private_eval_only";
export type Language = "he" | "en";
export type ConsentCopy = { text: string; sha256: string };

export type ContributorNext = {
  id: string;
  kind: ContributorKind;
  page: string;
} & (
  { kind: "print"; mode: CaptureMode; sheet: string } |
  { kind: "form"; sheet: string; persona: number } |
  { kind: "line"; crop: string; candidate: string } |
  { kind: "handwriting"; prompt: string; rights: string }
);

export type ContributorQueue = { kind: ContributorKind; done: number; total: number; next: ContributorNext | null };
export type ContributorProfile = {
  role: "writer" | "guardian";
  writer: string;
  ageBand: AgeBand;
  state: "guardian" | "assent" | "ready" | "withdrawn";
  receipt: string | null;
  licence: Licence;
  version: string;
  copy: Record<Language, ConsentCopy>;
  queues: ContributorQueue[];
};
