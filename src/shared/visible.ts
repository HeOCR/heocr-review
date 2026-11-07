/**
 * Make invisible characters visible: a reviewer must see a space, a no-break space, a direction mark or a
 * presentation-form letter that looks like an ordinary one.
 */

export type VisibleKind = "text" | "space" | "special";

export interface VisibleToken {
  kind: VisibleKind;
  /** What to show. */
  shown: string;
  /** The original characters. */
  raw: string;
  /** A label such as "U+00A0 NO-BREAK SPACE" for special tokens. */
  label?: string;
}

const NAMED: Record<string, [string, string]> = {
  " ": ["␣", "U+0020 SPACE"],
  "\u00a0": ["⍽", "U+00A0 NO-BREAK SPACE"],
  "\t": ["⇥", "U+0009 TAB"],
  "\n": ["↵", "U+000A LINE FEED"],
  "\r": ["␍", "U+000D CARRIAGE RETURN"],
  "\u200b": ["⟨ZWSP⟩", "U+200B ZERO WIDTH SPACE"],
  "\u200c": ["⟨ZWNJ⟩", "U+200C ZERO WIDTH NON-JOINER"],
  "\u200d": ["⟨ZWJ⟩", "U+200D ZERO WIDTH JOINER"],
  "\u200e": ["⟨LRM⟩", "U+200E LEFT-TO-RIGHT MARK"],
  "\u200f": ["⟨RLM⟩", "U+200F RIGHT-TO-LEFT MARK"],
  "\u061c": ["⟨ALM⟩", "U+061C ARABIC LETTER MARK"],
  "\ufeff": ["⟨BOM⟩", "U+FEFF ZERO WIDTH NO-BREAK SPACE"],
  "\u00ad": ["⟨SHY⟩", "U+00AD SOFT HYPHEN"],
};

export function codePoint(ch: string): string {
  return "U+" + (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
}

/** Characters that look like ordinary Hebrew letters but are not (presentation forms, U+FB1D-U+FB4F). */
function isLookalike(cp: number): boolean {
  return cp >= 0xfb1d && cp <= 0xfb4f;
}

const OTHER_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}]/u;

export function visibleTokens(text: string): VisibleToken[] {
  const out: VisibleToken[] = [];
  for (const ch of text) {
    const named = NAMED[ch];
    const cp = ch.codePointAt(0) ?? 0;
    if (named) {
      out.push({ kind: ch === " " ? "space" : "special", shown: named[0], raw: ch, label: named[1] });
    } else if (OTHER_INVISIBLE.test(ch)) {
      out.push({ kind: "special", shown: `⟨${codePoint(ch)}⟩`, raw: ch, label: codePoint(ch) });
    } else if (isLookalike(cp)) {
      out.push({ kind: "special", shown: ch, raw: ch, label: `${codePoint(ch)} presentation form` });
    } else {
      const last = out[out.length - 1];
      if (last && last.kind === "text") {
        last.shown += ch;
        last.raw += ch;
      } else out.push({ kind: "text", shown: ch, raw: ch });
    }
  }
  return out;
}

/** "U+05E2 U+0020" for the code points of a short string (used under a changed segment). */
export function codePoints(text: string, max = 24): string {
  const cps = Array.from(text, codePoint);
  return cps.length > max ? cps.slice(0, max).join(" ") + " …" : cps.join(" ");
}
