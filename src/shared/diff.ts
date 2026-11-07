/**
 * Grapheme-level diff for short spans (a proposal's current and proposed text).
 *
 * Graphemes keep a Hebrew letter together with its niqqud and cantillation marks, so a changed mark highlights
 * the whole letter it sits on instead of a detached combining character.
 */

export type DiffOp = "equal" | "delete" | "insert";

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

const MAX_GRAPHEMES = 2000;

export function graphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter("he", { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

function push(out: DiffSegment[], op: DiffOp, text: string): void {
  const last = out[out.length - 1];
  if (last && last.op === op) last.text += text;
  else out.push({ op, text });
}

/** The shortest edit script from `a` to `b` (LCS), merged into runs. Equal text appears once with op "equal". */
export function diffText(a: string, b: string): DiffSegment[] {
  const x = graphemes(a);
  const y = graphemes(b);
  if (x.length > MAX_GRAPHEMES || y.length > MAX_GRAPHEMES) {
    // Too long for a quadratic table: show it as a whole replacement.
    const out: DiffSegment[] = [];
    if (a) out.push({ op: "delete", text: a });
    if (b) out.push({ op: "insert", text: b });
    return out;
  }
  // Trim the common prefix and suffix first: most proposals change a letter or two.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  const n = xs.length;
  const m = ys.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = xs[i] === ys[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffSegment[] = [];
  if (pre) push(out, "equal", x.slice(0, pre).join(""));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) {
      push(out, "equal", xs[i]!);
      i++;
      j++;
    } else if (j < m && (i === n || table[i]![j + 1]! > table[i + 1]![j]!)) {
      push(out, "insert", ys[j]!);
      j++;
    } else {
      push(out, "delete", xs[i]!);
      i++;
    }
  }
  if (suf) push(out, "equal", x.slice(x.length - suf).join(""));
  return out;
}

/** The segments that make up the old text (equal + delete) and the new text (equal + insert). */
export function sides(segments: DiffSegment[]): { before: DiffSegment[]; after: DiffSegment[] } {
  return {
    before: segments.filter((s) => s.op !== "insert"),
    after: segments.filter((s) => s.op !== "delete"),
  };
}
