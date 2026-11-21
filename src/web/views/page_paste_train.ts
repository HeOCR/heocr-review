import type { BatchSummary } from "../../shared/api";
import { enteredPageLines, PAGE_PASTE_TEXT_LIMIT, type TrainingPage, type TrainingQueue } from "../../shared/page_paste_train";
import { ApiFailure, get, post } from "../api";
import { bdi, h, mount } from "../dom";
import { t } from "../i18n";
import type { ReviewHooks, ReviewScreen } from "./common";

export function pagePasteTrainView(batch: BatchSummary, hooks: ReviewHooks): ReviewScreen {
  const root = h("section", { class: "review page-paste" });
  const base = `/api/page-paste-train/${encodeURIComponent(batch.id)}`;
  const drafts = new Map<number, { text: string; revision: number | null }>();
  let disposed = false;
  let busy = false;

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

  const readPage = (id: number) => withTerms(() => get<TrainingQueue>(`${base}/pages/${id}`));
  const next = (after?: number) => withTerms(() => get<TrainingQueue>(`${base}/next${after === undefined ? "" : `?after=${after}`}`));

  function title() {
    return h("h1", {}, t("train_paste_title"));
  }

  function show(page: TrainingPage | null, done = false) {
    if (disposed) return;
    mount(root, title());
    if (done || !page) root.append(h("p", { role: "status" }, t("train_paste_done")));
    if (page) renderPage(page);
  }

  async function load() {
    mount(root, title(), h("p", { role: "status" }, t("loading")));
    try {
      const result = await next();
      const first = result.firstId != null ? await readPage(result.firstId) : result;
      show(first.page, result.page === null);
    } catch (err) {
      if (disposed) return;
      if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      mount(root, title(), h("p", { role: "alert" }, t("load_failed")),
        h("button", { type: "button", class: "act", onclick: () => void load() }, t("retry")));
    }
  }

  function renderPage(page: TrainingPage) {
    const pageHeading = t("train_paste_page", { page: page.key });
    const heading = h("h2", { tabindex: -1 }, bdi(`${page.key} · ${page.number}/${page.total}`, "ltr"));
    const zoom = h("input", { type: "range", min: 100, max: 300, step: 10, value: 100 });
    const scan = h("img", { width: page.image.width, height: page.image.height, alt: pageHeading });
    scan.style.setProperty("--scan-ratio", String(page.image.width / page.image.height));
    zoom.addEventListener("input", () => scan.style.setProperty("--scan-zoom", String(Number(zoom.value) / 100)));
    const area = h("textarea", { dir: "rtl", lang: "he", rows: 12, maxlength: PAGE_PASTE_TEXT_LIMIT, spellcheck: "false",
      "aria-describedby": "train-paste-hint train-paste-count" });
    const revision = page.saved?.revision ?? null;
    const draft = drafts.get(page.id);
    area.value = draft?.revision === revision ? draft.text : (page.saved?.text ?? "");
    const editable = !page.completed || page.saved !== null;
    const count = h("p", { id: "train-paste-count", role: "status" });
    const warning = h("span", { class: "page-paste-warning" }, t("train_paste_mismatch"));
    const err = h("p", { role: "alert", class: "msg" });
    const save = h("button", { class: "act primary", type: "submit" }, t("train_paste_save"));
    const retry = h("button", { type: "button", class: "act", hidden: true, onclick: () => {
      retry.hidden = true;
      err.textContent = "";
      scan.src = page.image.url;
    } }, t("retry"));
    const previous = h("button", { class: "act", type: "button", onclick: () => void browse(page.previousId) }, t("p_prev"));
    const forward = h("button", { class: "act", type: "button", onclick: () => void browse(page.nextId) }, t("more"));
    const skip = h("button", { class: "act", type: "button", onclick: () => void move(async () => {
      const result = await next(page.id);
      const fallback = page.nextId ?? result.firstId;
      return { page: result.page ?? (fallback != null ? (await readPage(fallback)).page : page) };
    }, "load_failed") }, t("skip"));

    function refresh() {
      const entered = enteredPageLines(area.value);
      mount(count, bdi(t("train_paste_counts", { detected: page.detectedCount, entered })), warning);
      warning.hidden = entered === page.detectedCount;
      previous.disabled = busy || page.previousId === null;
      forward.disabled = busy || page.nextId === null;
      skip.disabled = busy || page.total <= 1;
      save.disabled = busy || !editable || !scan.naturalWidth;
      area.readOnly = busy || !editable;
    }

    async function move(
      action: () => Promise<{ page: TrainingPage | null; done?: boolean }>,
      fallback: "load_failed" | "train_paste_failed",
    ) {
      if (busy || disposed) return;
      busy = true;
      refresh();
      err.textContent = "";
      let result;
      try {
        result = await action();
      } catch (error) {
        if (disposed) return;
        if (error instanceof ApiFailure && error.status === 401) return hooks.signedOut();
        if (error instanceof ApiFailure && error.code === "page_paste_saved") err.textContent = t("train_paste_already_saved");
        else if (error instanceof ApiFailure && error.code === "page_paste_text") err.textContent = t("train_paste_invalid");
        else err.textContent = t(fallback);
      } finally {
        busy = false;
        refresh();
      }
      if (result) show(result.page, result.done);
    }

    async function browse(id: number | null) {
      if (id === null) return;
      await move(() => readPage(id), "load_failed");
    }

    scan.addEventListener("load", refresh);
    scan.addEventListener("error", () => {
      err.textContent = t("train_paste_image_failed");
      retry.hidden = false;
      refresh();
    });
    scan.src = page.image.url;
    area.addEventListener("input", () => { drafts.set(page.id, { text: area.value, revision }); refresh(); });

    const form = h("form", { class: "page-paste-form", onsubmit: (event) => {
      event.preventDefault();
      if (save.disabled) return;
      void move(async () => {
        await withTerms(() => post(`${base}/pages/${page.id}`, { text: area.value, revision }));
        drafts.delete(page.id);
        const result = await next(page.id);
        if (result.page) return result;
        return { page: (await readPage(page.id)).page, done: true };
      }, "train_paste_failed");
    } },
    h("label", {}, t("train_paste_text"), area),
    h("p", { id: "train-paste-hint", class: "muted" }, t("train_paste_hint")),
    count, err, retry, save);
    // Buttons navigate without submitting the form or writing a decision.
    root.append(h("div", { class: "page-paste-tools" }, heading, previous, forward, skip),
      h("div", { class: "page-paste-grid" },
        h("div", { class: "page-paste-media" }, h("label", {}, t("train_paste_zoom"), zoom),
          h("div", { class: "page-paste-scan", tabindex: 0, "aria-label": pageHeading }, scan)),
        form));
    refresh();
    heading.focus();
  }

  void load();
  return { el: root, dispose: () => { disposed = true; } };
}
