/**
 * Split a line's candidate text into runs that are, or are not, inside an attention span (where the OCR engines
 * disagree with the candidate). Spans are code-point offsets, as Python counts them (hocrgen writes them). Runs
 * are widened to whole graphemes, so a highlighted niqqud mark never detaches from its letter. An empty span
 * (start = end) becomes an empty attention run: an insertion point.
 */
import { graphemes } from "./diff";

export interface AttentionRun {
  text: string;
  attention: boolean;
}

export function attentionRuns(text: string, spans: readonly (readonly [number, number])[]): AttentionRun[] {
  const cps = Array.from(text);
  const marked = new Array<boolean>(cps.length).fill(false);
  const points = new Set<number>(); // insertion points, in code points
  for (const [start, end] of spans) {
    if (start > cps.length || end < start) continue; // not a span of this text
    const s = Math.max(0, start);
    const e = Math.max(s, Math.min(cps.length, end));
    if (s === e) points.add(s);
    for (let i = s; i < e; i++) marked[i] = true;
  }
  const out: AttentionRun[] = [];
  const push = (t: string, attention: boolean) => {
    const last = out[out.length - 1];
    if (last && last.attention === attention && t !== "" && last.text !== "") last.text += t;
    else out.push({ text: t, attention });
  };
  let at = 0; // code point offset of the current grapheme
  for (const g of graphemes(text)) {
    const n = Array.from(g).length;
    // An insertion point anywhere inside this grapheme (or at its start) is shown before it.
    let point = false;
    for (let i = at; i < at + n; i++) if (points.has(i)) point = true;
    if (point) out.push({ text: "", attention: true });
    let hit = false;
    for (let i = at; i < at + n; i++) if (marked[i]) hit = true;
    push(g, hit);
    at += n;
  }
  if (points.has(cps.length)) out.push({ text: "", attention: true });
  return out;
}
