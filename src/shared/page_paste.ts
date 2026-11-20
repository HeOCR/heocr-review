/** Normalize clipboard newlines. Ignore one terminal delimiter, while retaining interior blank lines. */
export function pagePasteLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}
