import type { BatchSummary, PagePasteQueue } from "../../shared/api";
import { pagePasteLines } from "../../shared/page_paste";
import { ApiFailure, get, post } from "../api";
import { bdi, h, mount } from "../dom";
import { t } from "../i18n";
import type { ReviewHooks, ReviewScreen } from "./common";

export function pagePasteView(batch: BatchSummary, hooks: ReviewHooks): ReviewScreen {
  const root = h("section", { class: "review page-paste" });
  const base = `/api/batches/${encodeURIComponent(batch.id)}/page-paste`;
  const desktop = matchMedia("(min-width: 900px)");
  let disposed = false;
  let saving = false;
  let state: PagePasteQueue | undefined;
  let pendingText = "";

  function show() {
    if (disposed) return;
    root.replaceChildren(h("h1", {}, t("paste_title")));
    if (!desktop.matches) {
      root.append(h("p", {}, t("paste_desktop")));
    } else if (!state) {
      void load();
    } else if (!state.page) {
      root.append(h("p", {}, t("paste_done")));
    } else {
      renderPage(state.page);
    }
  }

  async function withTerms<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "terms_required" && !disposed) {
        await hooks.needTerms();
        return request();
      }
      throw err;
    }
  }

  async function load() {
    const message = h("p", { role: "status" }, t("loading"));
    root.append(message);
    try {
      state = await withTerms(() => get<PagePasteQueue>(`${base}/next`));
      show();
    } catch (err) {
      if (disposed) return;
      if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      message.textContent = t(err instanceof ApiFailure && err.code === "page_paste_stale" ? "paste_stale" : "load_failed");
      root.append(h("button", { type: "button", class: "act", onclick: show }, t("retry")));
    }
  }

  function renderPage(page: NonNullable<PagePasteQueue["page"]>) {
    const zoom = h("input", { type: "range", min: 100, max: 300, step: 10, value: 100, "aria-label": t("paste_zoom") });
    const scan = h("img", { src: page.image.url, width: page.image.width, height: page.image.height, alt: page.title, decoding: "async" });
    zoom.addEventListener("input", () => { scan.style.width = `${zoom.value}%`; });
    const area = h("textarea", { dir: "rtl", lang: "he", rows: 18, spellcheck: "false", "aria-describedby": "pp-hint pp-count" });
    area.value = pendingText;
    const count = h("p", { id: "pp-count", role: "status" });
    const err = h("p", { role: "alert", class: "msg" });
    const save = h("button", { class: "act primary", type: "submit" }, t("paste_save"));
    function refresh() {
      const entered = pagePasteLines(area.value).length;
      const label = t("paste_counts", { expected: page.expected, entered });
      if (count.textContent !== label) mount(count, bdi(label));
      save.disabled = entered !== page.expected || saving;
      area.readOnly = saving;
      err.textContent = entered !== 0 && entered !== page.expected ? t("paste_mismatch") : "";
    }
    area.addEventListener("input", () => { pendingText = area.value; refresh(); });
    const form = h("form", { class: "page-paste-form", onsubmit: async (event) => {
      event.preventDefault();
      if (!desktop.matches || saving || pagePasteLines(area.value).length !== page.expected) return;
      saving = true;
      refresh();
      try {
        await withTerms(() => post(`${base}/${page.itemId}`, { text: area.value }));
        pendingText = "";
        saving = false;
        state = undefined;
        show();
      } catch (error) {
        saving = false;
        refresh();
        if (disposed) return;
        if (error instanceof ApiFailure) {
          if (error.status === 401) return hooks.signedOut();
          if (error.code === "page_paste_count") return void (err.textContent = t("paste_mismatch"));
          if (error.code === "page_paste_invalid_line") return void (err.textContent = t("paste_line", { line: error.message }));
          if (error.code === "page_paste_stale") return void (err.textContent = t("paste_stale"));
        }
        err.textContent = t("paste_failed");
      }
    } },
    h("label", {}, t("paste_text"), area),
    h("p", { id: "pp-hint", class: "muted" }, t("paste_hint")),
    count, err, save);
    refresh();
    root.append(h("h2", {}, bdi(page.title)),
      h("div", { class: "page-paste-grid" },
        h("div", { class: "page-paste-media" }, h("label", {}, t("paste_zoom"), zoom),
          h("div", { class: "page-paste-scan", tabindex: 0, "aria-label": page.title }, scan)),
        form));
    area.focus({ preventScroll: true });
  }

  desktop.addEventListener("change", show);
  show();
  return { el: root, dispose: () => { disposed = true; desktop.removeEventListener("change", show); } };
}
