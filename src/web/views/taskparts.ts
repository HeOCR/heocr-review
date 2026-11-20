/**
 * Pieces the design's task screens share (line verification, volunteer lines, reference audit): the progress line,
 * the page column (beside the task on a desktop, full screen on a phone), the More sheet, the save state, the failed
 * notice and the whole-screen state. See design/review SPEC §3, §5, §6.
 */
import type { Progress } from "../../shared/api";
import type { ImageView } from "../../shared/media";
import { h } from "../dom";
import { t, tRich } from "../i18n";
import { icon, type IconName } from "../icons";
import { keepable, type FailureKind } from "../linerules";

/** A 3 px accent line and nothing else: counts, never streaks or agreement rates (SPEC §1). */
export function progressLine(p: Progress): HTMLElement {
  const pct = p.ownOnly || !p.total ? 0 : Math.round((p.covered / p.total) * 100);
  return h("div", { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct }, h("div", { class: "bar", style: `width:${pct}%` }));
}

/** One of the main answers in the dock (Exact, Correct it; Accept, Reject). */
export function answerButton(value: string, text: string, key: string, onclick: () => void, primary = false): HTMLElement {
  return h("button", { type: "button", class: primary ? "act primary" : "act", "data-value": value, onclick }, h("span", {}, text), key ? h("kbd", {}, key) : null);
}

/** One of the rare answers, in the More sheet on a phone and in the row on a desktop. */
export function moreButton(value: string, text: string, sub: string | null, ic: IconName | null, key: string, onclick: () => void): HTMLElement {
  return h(
    "button",
    { type: "button", class: "act", "data-value": value, onclick },
    ic ? icon(ic) : null,
    h("span", {}, text, sub ? h("span", { class: "sub" }, sub) : null),
    key ? h("kbd", {}, key) : null,
  );
}

export type SaveState = "saved" | "saving" | "failed" | null;

/** The save state's place: an icon and words, never colour alone (SPEC §5). */
export function renderSaveState(el: HTMLElement | null, state: SaveState): void {
  if (!el) return;
  el.dataset.state = state ?? "";
  el.replaceChildren(
    ...(state === "saved" ? [icon("exact", { sm: true }), t("saved")] : state === "saving" ? [t("saving")] : state === "failed" ? [icon("warning", { sm: true }), t("failed")] : []),
  );
}

/** The pressed answer says "Saving…"; every answer is disabled, so a second tap can't send a second decision. */
export function markSaving(root: HTMLElement, value: string): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>(".dock .act, .savebar .act")) {
    b.disabled = true;
    if (b.dataset.value === value) {
      b.dataset.busy = "";
      const span = b.querySelector("span");
      if (span?.firstChild) span.firstChild.textContent = t("saving");
    }
  }
}

export interface Failure {
  kind: FailureKind;
  kept: boolean;
  value: string;
  text?: string;
  reason?: string;
}

/** A failed save, in the slot: why, whether the answer is safe, and "Try again" (SPEC §6). */
export function failedNotice(f: Failure, retry: () => void): HTMLElement {
  const rich =
    f.kind === "offline"
      ? tRich("fail_note")
      : f.kind === "rate_limited"
        ? tRich("fail_rate")
        : f.kind === "daily_limit"
          ? tRich("fail_quota")
          : f.kind === "server"
            ? tRich("fail_srv")
            : tRich("fail_rejected", { reason: f.reason ?? t("e_srv_h") });
  return h(
    "div",
    { class: "notice failed", role: "alert" },
    icon(f.kind === "offline" ? "offline" : "warning"),
    h(
      "div",
      {},
      ...rich,
      !f.kept && keepable(f.kind) ? ` ${t("fail_unkept")}` : "",
      keepable(f.kind)
        ? h("div", { class: "row" }, h("button", { type: "button", class: "act", onclick: retry }, icon("reset", { sm: true }), t("retry")), f.kept ? h("span", { class: "tag" }, t("keep")) : null)
        : null,
    ),
  );
}

/** The design's whole-screen state: a framed icon, a title, one sentence and the actions. */
export function stateScreen(ic: IconName, title: string, text: string | null, ...actions: (HTMLElement | null)[]): HTMLElement {
  return h("section", { class: "state", role: "status" }, h("span", { class: "mark" }, icon(ic)), h("h1", {}, title), text ? h("p", { class: "muted" }, text) : null, h("div", { class: "stack" }, ...actions));
}

/** The image of a page or crop with a region in the brand box, as fractions of the image. */
export function boxedImage(img: ImageView, alt: string): HTMLElement {
  const b = img.box;
  return h(
    "div",
    { class: "frame" },
    h("img", { src: img.url, width: img.width, height: img.height, alt, decoding: "async", draggable: "false" }),
    b && !img.outlined ? h("div", { class: "hl", style: `left:${b[0] * 100}%;top:${b[1] * 100}%;width:${(b[2] - b[0]) * 100}%;height:${(b[3] - b[1]) * 100}%` }) : null,
  );
}

const PAGE_ZOOMS = [1, 1.5, 2, 3, 4];

/**
 * The page column and its behaviour: beside the task on a desktop (P enlarges it over the task), a full-screen view on
 * a phone (opened from the context band, closed with "Back to the line" or Esc). `onOpened` runs when a phone opens it.
 */
export interface PageColumn {
  el: HTMLElement;
  open(): void;
  close(): void;
  toggleEnlarged(): void;
  zoom(step: number): void;
  /** Esc: closes the phone's page or the enlarged page; true when it closed something. */
  escape(): boolean;
  isOpen(): boolean;
}

export function pageColumn(page: ImageView | null, where: string, source: (Node | string)[], onOpened: () => void, returnFocus: () => void): PageColumn {
  let zoomAt = 0;
  const scroller = h("div", { class: "scroller", tabindex: "0", "aria-label": t("pg") }, page ? boxedImage(page, `${t("pg")} · ${where}`) : h("p", { class: "muted src" }, t("no_image")));
  const layout = () => {
    const frame = scroller.querySelector<HTMLElement>(".frame");
    if (frame) frame.style.width = `${100 * PAGE_ZOOMS[zoomAt]!}%`;
    // Bring the line's box into view on the page.
    requestAnimationFrame(() => scroller.querySelector(".hl")?.scrollIntoView({ block: "center", inline: "center" }));
  };
  const api: PageColumn = {
    el: h(
      "aside",
      { class: "side", "aria-label": t("pg") },
      h("h2", {}, h("span", {}, `${t("pg")} · `, h("bdi", {}, where)), h("button", { type: "button", class: "act quiet desktop-only", onclick: () => api.toggleEnlarged(), disabled: !page }, t("enlarge"), " ", h("kbd", {}, "P"))),
      scroller,
      source.length ? h("p", { class: "src" }, ...source) : null,
      h(
        "div",
        { class: "backbar" },
        h("button", { type: "button", class: "act primary", onclick: () => api.close() }, icon("back"), t("back_line")),
        h("button", { type: "button", class: "act", "aria-label": t("zoom_out"), onclick: () => api.zoom(-1) }, icon("zoom-out")),
        h("button", { type: "button", class: "act", "aria-label": t("zoom_in"), onclick: () => api.zoom(1) }, icon("zoom-in")),
      ),
    ),
    open() {
      if (!page) return;
      api.el.classList.add("open");
      zoomAt = 0;
      layout();
      onOpened();
      api.el.querySelector<HTMLButtonElement>(".backbar .act")?.focus();
    },
    close() {
      api.el.classList.remove("open");
      returnFocus();
    },
    toggleEnlarged() {
      if (!page) return;
      api.el.classList.toggle("enlarged");
      layout();
    },
    zoom(step: number) {
      zoomAt = Math.max(0, Math.min(PAGE_ZOOMS.length - 1, zoomAt + step));
      layout();
    },
    escape() {
      if (api.el.classList.contains("open")) {
        api.close();
        return true;
      }
      if (api.el.classList.contains("enlarged")) {
        api.toggleEnlarged();
        return true;
      }
      return false;
    },
    isOpen: () => api.el.classList.contains("open"),
  };
  requestAnimationFrame(layout);
  return api;
}

/** The context band (the line among its neighbours); on a phone the whole band opens the page. */
export function contextBand(content: HTMLElement | null, hasPage: boolean, openPage: () => void): HTMLElement {
  return h(
    "div",
    { class: "ctxbox band", dir: "ltr", ...(hasPage ? { onclick: (e: Event) => (e.target as HTMLElement).closest(".open") || openPage() } : {}) },
    content,
    h("button", { type: "button", class: "open", disabled: !hasPage, onclick: openPage }, icon("page", { sm: true }), t("page")),
  );
}

/** The More sheet's open state (phone): the group, the scrim and the button's aria-expanded. */
export function setMoreOpen(root: HTMLElement, open: boolean): void {
  root.querySelector(".moregroup")?.classList.toggle("open", open);
  root.querySelector(".scrim")?.classList.toggle("open", open);
  root.querySelector(".more-btn")?.setAttribute("aria-expanded", String(open));
  if (open) root.querySelector<HTMLButtonElement>(".moregroup .act")?.focus();
}

export const moreIsOpen = (root: HTMLElement) => Boolean(root.querySelector(".moregroup.open"));

/** The dock: the main answers, the More group, and the quiet row (with the save state and More at the end). */
export function dock(answers: HTMLElement[], more: HTMLElement[], quiet: (HTMLElement | null)[], root: () => HTMLElement, evenAnswers = false): HTMLElement[] {
  return [
    h(
      "footer",
      { class: "dock" },
      h("nav", { class: evenAnswers ? "actions even" : "actions" }, ...answers, h("div", { class: "moregroup", role: "group", "aria-label": t("more") }, ...more)),
      h(
        "div",
        { class: "subnav" },
        ...quiet,
        h("span", { class: "savestate", role: "status" }),
        h("button", { type: "button", class: "act quiet more-btn", "aria-haspopup": "true", "aria-expanded": "false", onclick: () => setMoreOpen(root(), !moreIsOpen(root())) }, icon("more", { sm: true }), t("more")),
      ),
    ),
    h("div", { class: "scrim", onclick: () => setMoreOpen(root(), false) }),
  ];
}

/** The quiet zoom buttons for the crop. */
export function zoomButtons(step: (n: number) => void): HTMLElement[] {
  return [
    h("button", { type: "button", class: "act quiet zoom", "aria-label": t("zoom_out"), onclick: () => step(-1) }, icon("zoom-out", { sm: true }), h("kbd", {}, "−")),
    h("button", { type: "button", class: "act quiet zoom", "aria-label": t("zoom_in"), onclick: () => step(1) }, icon("zoom-in", { sm: true }), h("kbd", {}, "+")),
  ];
}

/** "2 pieces / Fit width" under the crop on a phone. */
export function cropBar(fit: boolean, setFit: (fit: boolean) => void): HTMLElement {
  return h(
    "div",
    { class: "cropbar" },
    h("button", { type: "button", "data-mode": "pieces", "aria-pressed": String(!fit), onclick: () => setFit(false) }, icon("pieces", { sm: true }), t("pieces")),
    h("button", { type: "button", "data-mode": "fit", "aria-pressed": String(fit), onclick: () => setFit(true) }, icon("fit", { sm: true }), t("fit")),
  );
}

/** The "?" key list, in the slot. */
export function keysPanel(keys: [string, string][]): HTMLElement {
  return h(
    "div",
    { class: "notice keys-panel", role: "dialog", "aria-label": t("keys_h") },
    icon("conventions"),
    h("div", {}, h("strong", {}, t("keys_h")), h("dl", {}, ...keys.flatMap(([k, s]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, s)]))),
  );
}
