type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | EventListener | null | undefined>;

/** Tiny DOM builder. Text children are always text nodes (never parsed as HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = String(value);
    // CSSOM rather than a style attribute (keeps working under a strict style-src).
    else if (key === "style") el.style.cssText = String(value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

export function mount(root: HTMLElement, ...nodes: Node[]): void {
  root.replaceChildren(...nodes);
}

export function bdi(text: string, dir: "ltr" | "rtl" | "auto" = "auto"): HTMLElement {
  return h("bdi", { dir }, text);
}
