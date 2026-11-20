import type { BatchSummary } from "../../shared/api";
import { enteredPageLines, PAGE_PASTE_TEXT_LIMIT, type TrainingPage, type TrainingQueue } from "../../shared/page_paste_train";
import { ApiFailure, get, post } from "../api";
import { bdi, h, mount } from "../dom";
import { t } from "../i18n";
import type { ReviewHooks, ReviewScreen } from "./common";

export function pagePasteTrainView(batch: BatchSummary, hooks: ReviewHooks): ReviewScreen {
  const root = h("section", { class: "review page-paste" });
  const base = `/api/page-paste-train/${encodeURIComponent(batch.id)}`;
  const desktop = matchMedia("(min-width: 900px)");
  let disposed = false;
  let loading = false;
  let loadFailed = false;
  let saving = false;
  let state: TrainingQueue | undefined;
  let pendingText = "";

  function show() {
    if (disposed) return;
    root.replaceChildren(h("h1", {}, t("train_paste_title")));
    if (!desktop.matches) {
      root.append(h("p", {}, t("train_paste_desktop")));
    } else if (loadFailed) {
      root.append(h("p", { role: "alert" }, t("load_failed")),
        h("button", { type: "button", class: "act", onclick: () => void load() }, t("retry")));
    } else if (!state) {
      root.append(h("p", { role: "status" }, t("loading")));
      if (!loading) void load();
    } else if (!state.page) {
      root.append(h("p", {}, t("train_paste_done")));
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
    loadFailed = false;
    loading = true;
    show();
    try {
      state = await withTerms(() => get<TrainingQueue>(`${base}/next`));
    } catch (err) {
      if (!disposed && err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      loadFailed = true;
    } finally {
      loading = false;
    }
    show();
  }

  function renderPage(page: TrainingPage) {
    const zoom = h("input", { type: "range", min: 100, max: 300, step: 10, value: 100 });
    const scan = h("img", { width: page.image.width, height: page.image.height, alt: t("train_paste_page", { page: page.key }) });
    scan.style.setProperty("--scan-ratio", String(page.image.width / page.image.height));
    zoom.addEventListener("input", () => scan.style.setProperty("--scan-zoom", String(Number(zoom.value) / 100)));
    const area = h("textarea", { dir: "rtl", lang: "he", rows: 18, maxlength: PAGE_PASTE_TEXT_LIMIT, spellcheck: "false",
      "aria-describedby": "train-paste-hint train-paste-count" });
    area.value = pendingText;
    const count = h("p", { id: "train-paste-count", role: "status" });
    const warning = h("span", { class: "page-paste-warning" }, t("train_paste_mismatch"));
    const err = h("p", { role: "alert", class: "msg" });
    const save = h("button", { class: "act primary", type: "submit" }, t("train_paste_save"));
    const retry = h("button", { type: "button", class: "act", hidden: true, onclick: () => {
      retry.hidden = true;
      err.textContent = "";
      scan.src = page.image.url;
    } }, t("retry"));

    function refresh() {
      const entered = enteredPageLines(area.value);
      mount(count, bdi(t("train_paste_counts", { detected: page.detectedCount, entered })), warning);
      warning.hidden = entered === page.detectedCount;
      save.disabled = saving || !scan.naturalWidth;
      area.readOnly = saving;
    }
    scan.addEventListener("load", refresh);
    scan.addEventListener("error", () => {
      err.textContent = t("train_paste_image_failed");
      retry.hidden = false;
      refresh();
    });
    scan.src = page.image.url;
    area.addEventListener("input", () => { pendingText = area.value; refresh(); });
    const form = h("form", { class: "page-paste-form", onsubmit: async (event) => {
      event.preventDefault();
      if (!desktop.matches || save.disabled) return;
      saving = true;
      refresh();
      err.textContent = "";
      try {
        await withTerms(() => post(`${base}/pages/${page.id}`, { text: area.value }));
        pendingText = "";
        state = undefined;
      } catch (error) {
        if (disposed) return;
        if (error instanceof ApiFailure && error.status === 401) return hooks.signedOut();
        if (error instanceof ApiFailure && error.code === "page_paste_saved") {
          err.textContent = t("train_paste_already_saved");
        } else {
          err.textContent = t(error instanceof ApiFailure && error.code === "page_paste_text" ? "train_paste_invalid" : "train_paste_failed");
        }
      } finally {
        saving = false;
        refresh();
      }
      if (!state || !desktop.matches) show();
    } },
    h("label", {}, t("train_paste_text"), area),
    h("p", { id: "train-paste-hint", class: "muted" }, t("train_paste_hint")),
    count, err, retry, save);
    refresh();
    const pageHeading = t("train_paste_page", { page: page.key });
    root.append(h("h2", {}, bdi(pageHeading)),
      h("div", { class: "page-paste-grid" },
        h("div", { class: "page-paste-media" }, h("label", {}, t("train_paste_zoom"), zoom),
          h("div", { class: "page-paste-scan", tabindex: 0, "aria-label": pageHeading }, scan)),
        form));
    area.focus({ preventScroll: true });
  }

  const resized = () => { if (!saving) show(); };
  desktop.addEventListener("change", resized);
  show();
  return { el: root, dispose: () => { disposed = true; desktop.removeEventListener("change", resized); } };
}
