/** Render a proposal's text with the differing graphemes marked and invisible characters shown. */
import { diffText, sides, type DiffSegment } from "../shared/diff";
import { codePoints, visibleTokens } from "../shared/visible";
import { h } from "./dom";

function visible(text: string): Node[] {
  return visibleTokens(text).map((t) => {
    if (t.kind === "text") return document.createTextNode(t.shown);
    const cls = t.kind === "space" ? "ws" : "sp";
    // Labels such as ⟨U+200F⟩ are Latin: isolate them so they never reorder the Hebrew around them.
    return h("bdi", { class: cls, title: t.label ?? "", dir: /^[⟨]/.test(t.shown) ? "ltr" : "auto" }, t.shown);
  });
}

function segmentNodes(segments: DiffSegment[], changedClass: string): Node[] {
  if (segments.length === 0) return [h("span", { class: "caret", title: "ריק / empty" }, "‸")];
  return segments.map((s) =>
    s.op === "equal" ? h("span", { class: "same" }, ...visible(s.text)) : h("mark", { class: changedClass }, ...visible(s.text)),
  );
}

/** One line: faded context, the span with its marks, faded context. */
export function textLine(before: string, spanSegments: DiffSegment[], after: string, changedClass: string): HTMLElement {
  return h(
    "div",
    { class: "txt", dir: "rtl", lang: "he" },
    h("span", { class: "ctx" }, before),
    h("span", { class: "span" }, ...segmentNodes(spanSegments, changedClass)),
    h("span", { class: "ctx" }, after),
  );
}

export interface Comparison {
  current: HTMLElement;
  proposed: HTMLElement;
  codes: HTMLElement;
}

export function compare(current: string, proposed: string, before: string, after: string): Comparison {
  const segments = diffText(current, proposed);
  const { before: was, after: now } = sides(segments);
  const changes = segments.filter((s) => s.op !== "equal");
  const del = changes.filter((s) => s.op === "delete").map((s) => s.text).join("");
  const ins = changes.filter((s) => s.op === "insert").map((s) => s.text).join("");
  const codes = h(
    "div",
    { class: "codes", dir: "ltr" },
    del ? h("span", { class: "del" }, codePoints(del)) : h("span", { class: "muted" }, "(none)"),
    " → ",
    ins ? h("span", { class: "ins" }, codePoints(ins)) : h("span", { class: "muted" }, "(none)"),
  );
  return {
    current: textLine(before, was.filter((s) => s.text !== ""), after, "del"),
    proposed: textLine(before, now.filter((s) => s.text !== ""), after, "ins"),
    codes,
  };
}
