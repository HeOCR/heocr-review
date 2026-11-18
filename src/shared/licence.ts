/**
 * Whether a text licence string names an open licence the app may import: CC0, public domain, CC BY or CC BY-SA.
 * A NonCommercial or NoDerivatives licence is refused even though it starts with "CC BY" (CC BY-NC, CC BY-NC-SA,
 * CC BY-ND, CC BY-NC-ND): HeOCR releases its data openly, and those licences forbid that.
 */
const OPEN = /\b(CC BY-SA|CC BY|CC0|public domain)\b/i;
const CLOSED = /\b(NC|ND)\b|non-?commercial|no-?deriv/i;

export function isOpenLicence(text: unknown): boolean {
  return typeof text === "string" && OPEN.test(text) && !CLOSED.test(text);
}

export const OPEN_LICENCE_PROBLEM = "text_license must name an open licence (CC BY-SA, CC BY, CC0 or public domain; not NonCommercial or NoDerivatives)";
