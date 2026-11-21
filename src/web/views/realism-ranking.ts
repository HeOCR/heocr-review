import type { BatchSummary } from "../../shared/api";
import { RANKING_MAPPING_VERSION, RANKING_TIE, type RankingChoice, type RankingPair, type RankingQueue } from "../../shared/synth_realism";
import { ApiFailure, get, post } from "../api";
import { bdi, h, mount } from "../dom";
import { t } from "../i18n";
import type { ReviewHooks, ReviewScreen } from "./common";

const sides = [0, 1] as const;
const shortcuts = new Map<string, RankingChoice>([["ArrowLeft", 0], ["ArrowRight", 1], ["ArrowUp", RANKING_TIE]]);

export function realismRankingView(batch: BatchSummary, hooks: ReviewHooks): ReviewScreen {
  const root = h("section", { class: "realism", "aria-labelledby": "ranking-heading" });
  const base = `/api/realism-ranking/${encodeURIComponent(batch.id)}`;
  const cache = new Map<number, { abort: AbortController; urls: string[]; images: Promise<HTMLImageElement[]> }>();
  let disposed = false;
  let busy = false;
  let chooseKey: ((choice: RankingChoice) => void) | null = null;

  function prefetch(pair: RankingPair) {
    const cached = cache.get(pair.position);
    if (cached) return cached.images;
    const abort = new AbortController();
    const urls: string[] = [];
    const images = Promise.all(pair.images.map(async (path) => {
      const response = await fetch(path, { signal: abort.signal });
      if (!response.ok) throw new ApiFailure(response.status, "error");
      const data = await response.blob();
      if (abort.signal.aborted) throw new Error("ranking view closed");
      const src = URL.createObjectURL(data);
      urls.push(src);
      const image = h("img", { src, alt: "" });
      await image.decode();
      return image;
    }));
    cache.set(pair.position, { abort, urls, images });
    return images;
  }

  function drop(position: number) {
    const entry = cache.get(position);
    entry?.abort.abort();
    entry?.urls.forEach((url) => URL.revokeObjectURL(url));
    cache.delete(position);
  }

  function report(error: unknown, status: HTMLElement) {
    if (disposed) return;
    if (error instanceof ApiFailure && error.status === 401) hooks.signedOut();
    else status.textContent = t(error instanceof ApiFailure && error.status === 429 ? "sr_slow" : "sr_retry");
  }

  async function load() {
    chooseKey = null;
    const status = h("p", { role: "status" }, t("loading"));
    mount(root, status);
    try {
      let state: RankingQueue;
      try { state = await get<RankingQueue>(`${base}/next`); }
      catch (error) {
        if (disposed || !(error instanceof ApiFailure) || error.code !== "terms_required") throw error;
        await hooks.needTerms();
        state = await get<RankingQueue>(`${base}/next`);
      }
      if (!disposed) draw(state);
    } catch (error) {
      report(error, status);
      if (!disposed) root.append(h("button", { type: "button", class: "act", onclick: () => void load() }, t("retry")));
    }
  }

  function draw(state: RankingQueue) {
    chooseKey = null;
    const { current, next, previous, total, completed } = state;
    for (const position of cache.keys()) {
      if (![previous?.position, current?.position, next?.position].includes(position)) drop(position);
    }
    const status = h("p", { class: "realism-status", role: "status" });
    const counter = h("div", { class: "realism-counter", role: "status" },
      bdi(t(current ? "sr_counter" : "sr_counter_done", { current: current ? completed + 1 : completed, total })));
    const buttons: HTMLButtonElement[] = [];
    const panels: { photo: HTMLImageElement; zoom: HTMLButtonElement; button: HTMLButtonElement; asset: string }[] = [];
    const physicalOrder = () => [...panels].sort((a, b) => a.photo.getBoundingClientRect().left - b.photo.getBoundingClientRect().left);
    const sideLabels = [
      { zoom: "rr_zoom_left", choice: "rr_choose_left", key: "ArrowLeft" },
      { zoom: "rr_zoom_right", choice: "rr_choose_right", key: "ArrowRight" },
    ] as const;
    let shownAt: number | null = null;
    let selection: { choice: RankingChoice; revision: number; latency_ms: number; left_asset: string } | null = null;
    const undo = previous ? h("button", { type: "button", class: "act quiet ranking-undo", onclick: () => {
      void save(`${base}/pairs/${previous.position}/undo`, { revision: previous.revision });
    } }, t("rr_undo")) : null;
    const dialog = h("dialog", { class: "ranking-dialog", "aria-labelledby": "ranking-zoom-title" });
    const bar = h("div", { class: "ranking-bar" }, counter, undo);
    const heading = h("h1", { id: "ranking-heading" }, t(current ? "rr_question" : "sr_done"));

    async function save(path: string, payload: unknown) {
      if (busy) return;
      busy = true;
      if (undo) undo.disabled = true;
      buttons.forEach((button) => { button.disabled = true; });
      status.textContent = "";
      try {
        const updated = await post<RankingQueue>(path, payload);
        if (!disposed) draw(updated);
      } catch (error) {
        report(error, status);
        if (undo) undo.disabled = false;
        if (shownAt !== null) buttons.forEach((button) => { button.disabled = false; });
      } finally {
        busy = false;
      }
    }

    if (!current) {
      mount(root, bar, heading, status, h("a", { href: "#tasks", class: "act" }, t("tasks")));
      return;
    }

    function choose(choice: RankingChoice) {
      if (busy || dialog.open || shownAt === null) return;
      selection ??= { choice, revision: current!.revision, left_asset: physicalOrder()[0]!.asset,
        latency_ms: Math.min(86_400_000, Math.round(performance.now() - shownAt)) };
      void save(`${base}/pairs/${current!.position}/choice`,
        { ...selection, tie_available: true, mapping_version: RANKING_MAPPING_VERSION });
    }

    const grid = h("div", { class: "realism-pair ranking-pair", dir: "ltr" });
    status.textContent = t("loading");
    mount(root, bar, heading, grid, status, dialog);
    const images = prefetch(current);
    if (next) {
      const preload = prefetch(next);
      void preload.catch(() => { if (cache.get(next.position)?.images === preload) drop(next.position); });
    }
    void images.then((ready) => {
      if (disposed || !status.isConnected) return;
      status.textContent = "";
      for (const side of sides) {
        const photo = ready[side]!;
        const zoom = h("button", { type: "button", class: "realism-panel ranking-image", onclick: () => {
          const label = t(sideLabels[physicalOrder()[0]!.photo === photo ? 0 : 1].zoom);
          mount(dialog, h("div", { class: "ranking-bar" }, h("span", { id: "ranking-zoom-title" }, label),
            h("button", { type: "button", class: "act", autofocus: true, onclick: () => dialog.close() }, t("close"))),
          h("img", { src: photo.src, alt: "" }));
          dialog.showModal();
        } }, h("span", { class: "realism-scan" }, photo));
        const button = h("button", { type: "button", class: "act ranking-choice", dir: "auto", disabled: true,
          onclick: () => choose(physicalOrder()[0]!.photo === photo ? 0 : 1) });
        panels.push({ photo, zoom, button, asset: current.images[side] });
        buttons.push(button);
        grid.append(h("div", { class: "ranking-panel" }, zoom, button));
      }
      const tie = h("button", { type: "button", class: "act ranking-choice ranking-tie", dir: "auto", disabled: true,
        "aria-keyshortcuts": "ArrowUp", onclick: () => choose(RANKING_TIE) }, t("rr_choose_tie"));
      buttons.push(tie);
      root.append(tie, h("p", { class: "ranking-keys" }, t("rr_keys")));
      requestAnimationFrame(() => {
        if (disposed || !status.isConnected) return;
        for (const [index, panel] of physicalOrder().entries()) {
          const labels = sideLabels[index]!;
          panel.zoom.setAttribute("aria-label", t(labels.zoom));
          panel.button.textContent = t(labels.choice);
          panel.button.setAttribute("aria-keyshortcuts", labels.key);
        }
        shownAt = performance.now();
        buttons.forEach((button) => { button.disabled = busy; });
        chooseKey = choose;
      });
    }, (error: unknown) => {
      if (disposed || !status.isConnected) return;
      drop(current.position);
      report(error, status);
      status.append(" ", h("button", { type: "button", class: "act", onclick: () => void load() }, t("retry")));
    });
  }

  function keydown(event: KeyboardEvent) {
    const choice = shortcuts.get(event.key);
    if (!chooseKey || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      root.querySelector("dialog[open]") || choice === undefined) return;
    event.preventDefault();
    chooseKey(choice);
  }
  window.addEventListener("keydown", keydown);
  void load();
  return { el: root, dispose: () => {
    disposed = true;
    window.removeEventListener("keydown", keydown);
    for (const position of cache.keys()) drop(position);
  } };
}
