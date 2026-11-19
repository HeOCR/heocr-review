/** Inline SVG icons from the design (design/review/icons), built with DOM calls: nothing is parsed as markup. */
import { ICONS } from "./icons.gen";

export type IconName = keyof typeof ICONS;
const SVG = "http://www.w3.org/2000/svg";

/** An icon as review.css draws it (`.ico`, `.sm` for 20 px). Decorative unless a label is given. */
export function icon(name: IconName, opts: { sm?: boolean; label?: string } = {}): SVGSVGElement {
  const def = ICONS[name];
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", ["ico", opts.sm ? "sm" : "", def.flip ? "flip" : ""].filter(Boolean).join(" "));
  svg.setAttribute("viewBox", "0 0 24 24");
  if (opts.label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", opts.label);
  } else svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of def.shapes) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** The HeOCR mark (the box with its handles around a letter), for the top bar's home link. */
export function mark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  shape("rect", { x: "7", y: "7", width: "34", height: "34", class: "lg-box" });
  for (const [x, y] of [["4", "4"], ["38", "4"], ["4", "38"], ["38", "38"]] as const) shape("rect", { x, y, width: "6", height: "6", class: "lg-h" });
  shape("path", { d: "M16 18H32V32.5M16 24.5V32.5", class: "lg-ink" });
  return svg;
}
