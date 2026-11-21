export const PAGE_PASTE_TRAIN = "page_paste_train";
export const PAGE_PASTE_TEXT_LIMIT = 32_000;

export interface TrainingPage {
  id: number;
  key: string;
  image: { url: string; width: number; height: number };
  detectedCount: number;
  number: number;
  total: number;
  previousId: number | null;
  nextId: number | null;
  completed: boolean;
  saved: { text: string; revision: number } | null;
}

export interface TrainingQueue {
  page: TrainingPage | null;
  firstId?: number | null;
}

export function normalizePageBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Count nonblank lines for the soft check. Keep blank lines and whitespace in the saved text. */
export function enteredPageLines(text: string): number {
  return normalizePageBreaks(text).split("\n").filter((line) => line.trim() !== "").length;
}
