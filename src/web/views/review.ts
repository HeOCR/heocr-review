/**
 * The reference audit screen (task type text_correction), in the design's layout (design/review SPEC §4.4): the crop,
 * a category tag, the text now and the text proposed with the difference marked, and the agent's note as a quiet
 * quote. Accept and Reject are equal and both outlined: neither is the expected answer. Edit and Skip are in More on
 * a phone. The page is beside the task on a desktop and behind "Full page" on a phone.
 * Keys (as before): A/1 accept · R/2 reject · E/3 edit · S/4 skip · B previous · +/−, Z/X zoom · P page · ? · Esc.
 */
import type { BatchSummary, NextResponse, Progress, ProposalView, TextCorrectionView } from "../../shared/api";
import { diffText, sides } from "../../shared/diff";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { lang, t } from "../i18n";
import { icon } from "../icons";
import { DESKTOP_QUERY, clearDraft, dropPending, failureKind, keepPending, keepable, pendingFor, readDraft, writeDraft } from "../linerules";
import { compare, textLine } from "../text";
import { prefetch, type ReviewHooks, type ReviewScreen } from "./common";
import { lineStrip, stripPieces } from "./line";
import {
  answerButton,
  boxedImage,
  contextBand,
  cropBar,
  dock,
  failedNotice,
  keysPanel,
  markSaving,
  moreButton,
  moreIsOpen,
  pageColumn,
  progressLine,
  renderSaveState,
  setMoreOpen,
  stateScreen,
  zoomButtons,
  type Failure,
  type PageColumn,
  type SaveState,
} from "./taskparts";

const LINE_HEIGHTS = [40, 52, 66, 84, 108, 140];

/** `startAt` opens one proposal first (link #p/<id>); then the queue continues. */
export function reviewView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number): ReviewScreen {
  const root = h("div", { class: "taskroot" });
  const desktopMq = matchMedia(DESKTOP_QUERY);
  const history: number[] = [];
  let current: ProposalView | null = null;
  let revisiting = false;
  let progress: Progress = batch.progress;
  let editing: HTMLTextAreaElement | null = null;
  let busy = false;
  // A desktop starts at the largest ink height, so a long line fills the column as one strip (the zoom buttons step
  // down); a phone starts at its two-piece size.
  let zoom = desktopMq.matches ? LINE_HEIGHTS.length - 1 : 2;
  let fitWidth = false;
  let keysOpen = false;
  let failure: Failure | null = null;
  let saveState: SaveState = null;
  let page: PageColumn | null = null;
  const view = (): TextCorrectionView | null => (current && current.view.kind === "text_correction" ? current.view : null);
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const status = (text: string) => {
    const msg = q(".msg");
    if (msg) msg.textContent = text;
  };
  const body = document.body.classList;
  const desktop = () => desktopMq.matches;

  async function loadNext(): Promise<void> {
    const res = await get<NextResponse>(`/api/batches/${encodeURIComponent(batch.id)}/next`);
    progress = res.progress;
    prefetch(res.prefetch);
    current = res.proposal;
    revisiting = false;
    failure = null;
    if (current) render();
    else renderDone();
  }

  async function open(id: number): Promise<void> {
    const res = await get<{ proposal: ProposalView }>(`/api/proposals/${id}`);
    current = res.proposal;
    revisiting = true;
    failure = null;
    render();
  }

  function failScreen(err: unknown): void {
    if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
    const kind = failureKind(err, navigator.onLine);
    const [title, text] = kind === "offline" ? (["e_off_h", "e_off_p"] as const) : kind === "rate_limited" ? (["e_rate_h", "e_rate_p"] as const) : kind === "daily_limit" ? (["e_quota_h", "e_quota_p"] as const) : (["e_srv_h", "e_srv_hint"] as const);
    mount(root, stateScreen(kind === "offline" ? "offline" : kind === "rate_limited" ? "clock" : "warning", t(title), t(text), h("button", { type: "button", class: "act primary", onclick: () => void loadNext().catch(failScreen) }, t("retry"))));
    console.warn(err);
  }

  async function send(id: number, value: string, text?: string): Promise<void> {
    const payload = text === undefined ? { value } : { value, text };
    try {
      await post(`/api/proposals/${id}/decision`, payload);
    } catch (err) {
      if (!(err instanceof ApiFailure && err.code === "terms_required")) throw err;
      await hooks.needTerms();
      await post(`/api/proposals/${id}/decision`, payload);
    }
  }

  async function act(value: string, text?: string): Promise<void> {
    if (!current || busy) return;
    setMoreOpen(root, false);
    busy = true;
    const id = current.id;
    markSaving(root, value);
    renderSaveState(q(".savestate"), (saveState = "saving"));
    try {
      await send(id, value, text);
      dropPending(id);
      clearDraft(id);
      if (history[history.length - 1] !== id) history.push(id);
      saveState = "saved";
      await loadNext();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      const kind = failureKind(err, navigator.onLine);
      const kept = keepable(kind) && keepPending({ proposalId: id, batchId: batch.id, value, ...(text === undefined ? {} : { text }), keptAt: new Date().toISOString() });
      failure = { kind, kept, value, ...(text === undefined ? {} : { text }), ...(err instanceof ApiFailure && err.message ? { reason: err.message } : {}) };
      saveState = "failed";
      render();
      console.warn(err);
    } finally {
      busy = false;
    }
  }

  async function resendKept(): Promise<void> {
    if (busy) return;
    const kept = pendingFor(batch.id);
    if (!kept.length) return;
    busy = true;
    let currentSent = false;
    try {
      for (const p of kept) {
        try {
          await send(p.proposalId, p.value, p.text);
          dropPending(p.proposalId);
          clearDraft(p.proposalId);
          if (current?.id === p.proposalId) currentSent = true;
        } catch (err) {
          if (!keepable(failureKind(err, navigator.onLine))) dropPending(p.proposalId);
          else break;
        }
      }
    } finally {
      busy = false;
    }
    if (currentSent) {
      saveState = "saved";
      await loadNext().catch(failScreen);
    } else if (!pendingFor(batch.id).length && failure) {
      failure = null;
      saveState = "saved";
      render();
    }
  }

  async function doSkip(): Promise<void> {
    if (!current || busy) return;
    setMoreOpen(root, false);
    busy = true;
    markSaving(root, "skip");
    try {
      await post(`/api/proposals/${current.id}/skip`);
      history.push(current.id);
      await loadNext();
    } catch (err) {
      busy = false;
      if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      render();
      status(t("e_srv_h"));
      console.warn(err);
    } finally {
      busy = false;
    }
  }

  function back(): void {
    const id = history.pop();
    if (id !== undefined) open(id).catch(failScreen);
  }

  function closeEditor(): void {
    editing = null;
    body.remove("editing");
    const box = q(".editbox");
    if (box) {
      box.replaceChildren();
      box.hidden = true;
    }
  }

  function startEdit(): void {
    const v = view();
    setMoreOpen(root, false);
    if (!v || !current) return;
    if (editing) return editing.focus();
    const p = current;
    const box = q(".editbox")!;
    const area = h("textarea", { dir: "rtl", lang: "he", rows: 3, spellcheck: "false", autocomplete: "off", autocapitalize: "off", maxlength: 1000, "aria-label": t("a_edit") });
    area.value = readDraft(p.id) ?? (p.mine?.value === "edited" && p.mine.text !== null ? p.mine.text : v.proposed);
    const preview = h("div", { class: "preview" });
    const update = () => {
      writeDraft(p.id, area.value);
      const { after } = sides(diffText(v.current, area.value));
      preview.replaceChildren(textLine(v.contextBefore, after.filter((s) => s.text), v.contextAfter, "edit"));
    };
    const save = () => void act("edited", area.value);
    const cancel = () => {
      clearDraft(p.id);
      closeEditor();
      q<HTMLButtonElement>(".dock .act")?.focus();
    };
    area.addEventListener("input", update);
    area.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    box.replaceChildren(
      area,
      preview,
      h(
        "div",
        { class: "savebar" },
        h("button", { type: "button", class: "act primary", "data-value": "edited", onclick: save }, h("span", {}, t("save")), " ", h("kbd", {}, "Ctrl+Enter")),
        h("button", { type: "button", class: "act", onclick: cancel }, t("cancel"), " ", h("kbd", {}, "Esc")),
      ),
    );
    box.hidden = false;
    body.add("editing");
    editing = area;
    update();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** The crop: the region cut from the crop image as a line strip when it has a box, else the crop itself. */
  function renderStrip(): void {
    const v = view();
    const holder = q(".linebox .strip");
    if (!v || !holder) return;
    if (!v.crop) {
      holder.replaceChildren(h("p", { class: "muted" }, t("no_image")));
      return;
    }
    if (!v.crop.box) {
      holder.replaceChildren(boxedImage(v.crop, t("line_on_scan")));
      return;
    }
    const width = Math.max(200, holder.clientWidth || root.clientWidth || 360);
    const pieces = stripPieces(v.crop, v.crop.box, width, desktop(), fitWidth);
    holder.replaceChildren(lineStrip(v.crop, v.crop.box, LINE_HEIGHTS[zoom]!, width, () => undefined, pieces, t("line_on_scan")));
  }

  function setZoom(step: number): void {
    zoom = Math.max(0, Math.min(LINE_HEIGHTS.length - 1, zoom + step));
    renderStrip();
  }

  const KEYS = (): [string, string][] => [
    ["A · 1", t("accept")],
    ["R · 2", t("reject")],
    ["E · 3", t("a_edit")],
    ["S · 4", t("skip")],
    ["B", t("prev")],
    ["+ / − · Z / X", t("zoom_in")],
    ["P", t("page")],
    ["Esc", t("close")],
  ];

  function render(): void {
    const p = current!;
    const v = view();
    if (!v) throw new Error(`reviewView cannot show ${p.view.kind}`);
    closeEditor();
    keysOpen = false;
    const cmp = compare(v.current, v.proposed, v.contextBefore, v.contextAfter);
    const option = (value: string) => p.options.find((o) => o.value === value);
    const mine = p.mine ? option(p.mine.value) : undefined;
    hooks.where?.(null);
    page = pageColumn(v.page, p.itemTitle, [], () => undefined, () => q<HTMLButtonElement>(".ctxbox .open")?.focus());
    const work = h(
      "div",
      { class: "review audit" },
      h("p", { class: "ask" }, t("a_ask")),
      h("div", { class: "linebox" }, h("div", { class: "strip" }), v.crop?.box ? cropBar(fitWidth, (fit) => ((fitWidth = fit), render())) : null),
      h("div", { class: "row" }, h("span", { class: "tag" }, v.category.label[lang()])),
      h(
        "div",
        { class: "texts" },
        h("div", { class: "row" }, h("span", { class: "lab" }, t("now")), cmp.current),
        h("div", { class: "row" }, h("span", { class: "lab" }, t("proposed")), cmp.proposed),
        h("div", { class: "row desktop-only" }, h("span", { class: "lab" }, ""), cmp.codes),
      ),
      v.note ? h("p", { class: "note" }, `${t("a_note_lab")} `, h("bdi", { dir: "auto" }, v.note)) : null,
      h(
        "div",
        { class: "slot" },
        failure ? failedNotice(failure, () => (failure!.kept ? void resendKept() : void act(failure!.value, failure!.text))) : null,
        revisiting && mine ? h("p", { class: "mine" }, t("mine", { v: mine.label[lang()] }), p.mine?.text ? ` («${p.mine.text}»)` : "", ` · ${t("mine_replace")}`) : null,
        h("p", { class: "msg", role: "status" }),
      ),
      h("div", { class: "editbox", hidden: true }),
      contextBand(null, Boolean(v.page), () => page?.open()),
      ...dock(
        [answerButton("accepted", t("accept"), "A", () => void act("accepted")), answerButton("rejected", t("reject"), "R", () => void act("rejected"))],
        [moreButton("edited", t("a_edit"), null, "edit", "E", startEdit), moreButton("skip", t("skip"), t("skip_sub"), "skip", "S", () => void doSkip())],
        [
          h("button", { type: "button", class: "act quiet", onclick: back, disabled: history.length === 0 }, icon("previous", { sm: true }), t("prev"), " ", h("kbd", {}, "B")),
          ...zoomButtons(setZoom),
          revisiting ? h("button", { type: "button", class: "act quiet", onclick: () => void loadNext().catch(failScreen) }, t("to_queue")) : null,
        ],
        () => root,
        true,
      ),
    );
    mount(root, progressLine(progress), h("div", { class: "deck" }, work, page.el));
    renderSaveState(q(".savestate"), saveState);
    renderStrip();
    q<HTMLButtonElement>(".dock .act")?.focus({ preventScroll: true });
  }

  function renderDone(): void {
    hooks.where?.(null);
    mount(
      root,
      stateScreen(
        "exact",
        t("done_a"),
        null,
        progress.skippedByMe ? h("button", { type: "button", class: "act primary", onclick: () => void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`).then(loadNext).catch(failScreen) }, t("done_a_skips", { n: progress.skippedByMe })) : null,
        history.length ? h("button", { type: "button", class: "act", onclick: back }, icon("previous", { sm: true }), t("done_last")) : null,
        h("a", { class: "act quiet", href: "#tasks" }, t("all_tasks")),
      ),
    );
  }

  function escape(): boolean {
    if (keysOpen) {
      keysOpen = false;
      q(".keys-panel")?.remove();
      return true;
    }
    if (moreIsOpen(root)) {
      setMoreOpen(root, false);
      return true;
    }
    return page?.escape() ?? false;
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (e.key === "Escape" && escape()) return e.preventDefault();
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
    if (target && (target.tagName === "BUTTON" || target.tagName === "A") && (e.key === "Enter" || e.key === " ")) return;
    if (!current || !q(".dock")) return;
    if (e.repeat) return e.preventDefault();
    if (e.key === "?") {
      e.preventDefault();
      keysOpen = !keysOpen;
      q(".keys-panel")?.remove();
      if (keysOpen) q(".slot")?.prepend(keysPanel(KEYS()));
      return;
    }
    // e.code is the physical key, so the shortcuts work in a Hebrew keyboard layout too.
    const actions: Record<string, () => void> = {
      KeyA: () => void act("accepted"),
      Digit1: () => void act("accepted"),
      KeyR: () => void act("rejected"),
      Digit2: () => void act("rejected"),
      KeyE: startEdit,
      Digit3: startEdit,
      KeyS: () => void doSkip(),
      Digit4: () => void doSkip(),
      KeyB: back,
      Equal: () => setZoom(1),
      NumpadAdd: () => setZoom(1),
      KeyZ: () => setZoom(1),
      Minus: () => setZoom(-1),
      NumpadSubtract: () => setZoom(-1),
      KeyX: () => setZoom(-1),
      KeyP: () => (desktop() ? page?.toggleEnlarged() : page?.isOpen() ? page.close() : page?.open()),
    };
    const fn = actions[e.code];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderStrip, 120);
  };
  const onOnline = () => void resendKept();
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  window.addEventListener("online", onOnline);
  desktopMq.addEventListener("change", renderStrip);
  mount(root, h("p", { class: "muted" }, t("loading")));
  (startAt === undefined ? resendKept().then(loadNext) : open(startAt)).catch(failScreen);
  return {
    el: root,
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("online", onOnline);
      desktopMq.removeEventListener("change", renderStrip);
      body.remove("editing");
    },
  };
}
