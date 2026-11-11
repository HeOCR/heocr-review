/** Hebrew points and cantillation (U+0591-U+05C7), except maqaf, paseq, sof pasuq and nun hafukha (hocrgen's set). */
const NIQQUD_OR_MARK = /[\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7]/u;

/** True when a text holds niqqud or cantillation marks, which a `pointed_print` text (letters only) must not. */
export function hasNiqqud(text: string): boolean {
  return NIQQUD_OR_MARK.test(text);
}
