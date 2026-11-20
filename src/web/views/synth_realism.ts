import type { BatchSummary } from "../../shared/api";
import { TAGS, type RealismQueue, type RealismTrial, type Side } from "../../shared/synth_realism";
import { ApiFailure, post } from "../api";
import { bdi, h, mount } from "../dom";
import { t, type StringKey } from "../i18n";
import type { ReviewHooks, ReviewScreen } from "./common";

const sides = [0, 1] as const;

export function synthRealismView(batch: BatchSummary, hooks: ReviewHooks): ReviewScreen {
  const root = h("section", { class: "realism", "aria-labelledby": "realism-heading" });
  const base = `/api/synth-realism/${encodeURIComponent(batch.id)}`;
  let disposed = false;
  let busy = false;

  async function request<T>(path: string, body: unknown = {}): Promise<T> {
    try {
      return await post<T>(path, body);
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "terms_required" && !disposed) {
        await hooks.needTerms();
        return post<T>(path, body);
      }
      throw error;
    }
  }

  function report(error: unknown, status: HTMLElement) {
    if (disposed) return;
    if (error instanceof ApiFailure && error.status === 401) hooks.signedOut();
    else status.textContent = t(error instanceof ApiFailure && error.code === "rate_limited" ? "sr_slow" : "sr_retry");
  }

  async function load() {
    const message = h("p", { role: "status" }, t("loading"));
    mount(root, message);
    try {
      const state = await request<RealismQueue>(`${base}/next`);
      if (!disposed) {
        draw(state);
        window.scrollTo(0, 0);
      }
    } catch (error) {
      report(error, message);
      if (!disposed) root.append(h("button", { type: "button", class: "act", onclick: () => void load() }, t("retry")));
    }
  }

  function draw(state: RealismQueue, focus = false): void {
    const trial = state.trial;
    if (!trial) {
      mount(root, h("h1", { id: "realism-heading" }, t("sr_done")),
        h("p", {}, bdi(t("sr_counter_done", { current: state.completed, total: state.total }))),
        h("a", { href: "#tasks", class: "act" }, t("tasks")));
      return;
    }

    const heading = h("h1", { id: "realism-heading", tabindex: -1 }, t(trial.reveal ? "sr_compare" : "sr_question"));
    const status = h("p", { class: "realism-status", role: "status" });
    const counter = h("div", { class: "realism-counter" }, bdi(t("sr_counter", { current: state.completed + 1, total: state.total })));
    const images = sides.map((side) => h("img", { src: trial.pair[side].page, alt: "", decoding: "async" }));
    const buttons: HTMLButtonElement[] = [];
    let shownAt = 0;
    let selection: { choice: Side; latency_ms: number } | null = null;

    async function choose(side: Side) {
      if (busy || !shownAt || trial!.reveal) return;
      // Preserve the original click and its timing when a network retry is needed.
      selection ??= { choice: side, latency_ms: Math.round(performance.now() - shownAt) };
      busy = true;
      buttons.forEach((button) => (button.disabled = true));
      status.textContent = "";
      try {
        const next = await request<RealismTrial>(`${base}/trials/${trial!.id}/choice`, selection);
        if (!disposed) draw({ ...state, trial: next }, true);
      } catch (error) {
        report(error, status);
        buttons.forEach((button) => (button.disabled = false));
      } finally {
        busy = false;
      }
    }

    const pair = h("div", { class: "realism-pair", dir: "ltr" }, ...sides.map((side) => {
      const label = t(trial.reveal ? trial.reveal.synthetic[side] ? "sr_synthetic" : "sr_real" : side === 0 ? "sr_left" : "sr_right");
      const caption = h("span", { class: "realism-caption", dir: "auto" }, label);
      const image = h("span", { class: "realism-scan" }, images[side]!);
      if (trial.reveal) {
        return h("div", { class: "realism-panel", "data-chosen": trial.reveal.choice === side ? "true" : null }, image, caption);
      }
      const button = h("button", { type: "button", class: "realism-panel realism-select", disabled: true, onclick: () => void choose(side) }, image, caption);
      buttons.push(button);
      return button;
    }));
    const zoom = h("details", { class: "realism-zoom" },
      h("summary", {}, t("sr_zoom")),
      h("div", { class: "realism-pair realism-zoom-grid", dir: "ltr" }, ...sides.map((side) =>
        h("figure", {},
          h("img", { src: trial.pair[side].line, alt: t(side === 0 ? "sr_left_line" : "sr_right_line"), loading: "lazy" }),
          h("figcaption", { dir: "auto" }, t(side === 0 ? "sr_left" : "sr_right"))))),
    );
    mount(root, counter, heading, pair, zoom,
      ...(trial.reveal ? [feedback(trial, state, status)] : []), status);
    if (focus) heading.focus({ preventScroll: true });
    if (!trial.reveal) {
      void Promise.all(images.map((img) => img.decode())).then(() => {
        if (disposed) return;
        shownAt = performance.now();
        buttons.forEach((button) => (button.disabled = false));
      }, (error: unknown) => {
        report(error, status);
        if (!disposed) status.append(" ", h("button", { type: "button", class: "act", onclick: () => void load() }, t("retry")));
      });
    }
  }

  function feedback(trial: RealismTrial, state: RealismQueue, status: HTMLElement): HTMLFormElement {
    const bothReal = trial.reveal!.synthetic.every((synthetic) => !synthetic);
    const score = h("fieldset", { class: "realism-field" }, h("legend", {}, t(bothReal ? "sr_rating_pair" : "sr_rating"), " ", bdi("(0–10)", "ltr")),
      h("div", { dir: "ltr", class: "realism-scores" }, ...Array.from({ length: 11 }, (_, i) =>
        h("label", {}, h("input", { type: "radio", name: "score", value: i, required: true }), h("span", {}, String(i))))));
    const tags = h("fieldset", { class: "realism-field" }, h("legend", {}, t("sr_tags")),
      h("div", { class: "realism-tags" }, ...TAGS.map((tag) =>
        h("label", {}, h("input", { type: "checkbox", name: "tags", value: tag }), h("span", {}, t(`sr_${tag}` as StringKey))))));
    const comment = h("label", { class: "realism-comment" }, t("sr_comment"), h("textarea", { name: "comment", rows: 2, maxlength: 1000, dir: "auto" }));
    const next = h("button", { type: "submit", class: "act primary" }, t(state.completed + 1 === state.total ? "sr_finish" : "sr_next"));
    const form = h("form", { class: "realism-feedback", onsubmit: (event) => {
      event.preventDefault();
      if (busy) return;
      const data = new FormData(form);
      const payload = { score: Number(data.get("score")), tags: data.getAll("tags"), comment: data.get("comment") };
      busy = true;
      next.disabled = true;
      status.textContent = "";
      void request(`${base}/trials/${trial.id}/feedback`, payload).then(async () => {
        if (!disposed) await load();
      }, (error: unknown) => {
        report(error, status);
        next.disabled = false;
      }).finally(() => { busy = false; });
    } }, score, tags, comment, next);
    return form;
  }

  void load();
  return { el: root, dispose: () => { disposed = true; } };
}
