export const SYNTH_REALISM = "synth_realism";
export const TAGS = [
  "too_clean", "soft_texture", "surface_ink", "uniform_noise", "wrong_era_font",
  "wrong_layout", "wrong_paper_colour", "too_sharp", "too_blurry", "artefacts",
] as const;
export type RealismTag = (typeof TAGS)[number];
export type Side = 0 | 1;

export interface RealismTrial {
  id: string;
  pair: [{ page: string; line: string }, { page: string; line: string }];
  /** Only sent after the choice has been saved. False means the image on that side is real. */
  reveal: { choice: Side; synthetic: [boolean, boolean] } | null;
}

export interface RealismQueue {
  total: number;
  completed: number;
  trial: RealismTrial | null;
}
