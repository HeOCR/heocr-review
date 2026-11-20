/**
 * The volunteer line review screen (task type line_consensus), in the design's layout (design/review SPEC §4.3): the
 * line verification screen with Correct and Correct it as the main answers; More holds Print has niqqud, Unreadable,
 * Not on the page and Skip. A volunteer never sees another volunteer's decision or any count of others' work, and a
 * decision is final, so there is no Previous. Look-here hints are chips in the slot; Help reopens the introduction.
 * Keys: Enter correct · E edit · N print has niqqud (opens the editor) · S skip · +/− zoom · P page · ? keys · Esc.
 * Unreadable and Not on the page have buttons only: decisions are final, and a stray key must not make one.
 */
import type { BatchSummary, LineConsensusView, NextResponse, Progress, ProposalView } from "../../shared/api";
import type { Box, ImageView } from "../../shared/media";
import { hasNiqqud } from "../../shared/niqqud";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { lang, t } from "../i18n";
import { icon } from "../icons";
import { DESKTOP_QUERY, clearDraft, dropPending, failureKind, keepPending, keepable, pendingFor, readDraft, writeDraft } from "../linerules";
import { compare } from "../text";
import { prefetch, type ReviewHooks, type ReviewScreen } from "./common";
import { LINE_CONVENTIONS } from "./conventions";
import { candidateNodes, lineStrip, stripPieces } from "./line";
import {
  answerButton,
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

/**
 * The band around the line, cut from the page image (the image is the page; `region` and the line's box are page
 * fractions), at most the holder's width and 160 px high, with the line in the brand box.
 */
function bandImage(img: ImageView, region: Box, width: number): HTMLElement {
  const rw = (region[2] - region[0]) * img.width;
  const rh = (region[3] - region[1]) * img.height;
  const scale = Math.min(width / rw, 160 / rh);
  const image = h("img", { src: img.url, alt: t("line_ctx"), decoding: "async", draggable: "false" });
  image.style.cssText = `position:absolute;max-width:none;width:${img.width * scale}px;left:${-region[0] * img.width * scale}px;top:${-region[1] * img.height * scale}px`;
  const band = h("div", { class: "frame" }, image);
  band.style.cssText = `position:relative;overflow:hidden;width:${rw * scale}px;height:${rh * scale}px;margin-inline:auto`;
  const b = img.box;
  if (b) {
    const hl = h("div", { class: "hl" });
    hl.style.cssText = `left:${((b[0] - region[0]) / (region[2] - region[0])) * 100}%;top:${((b[1] - region[1]) / (region[3] - region[1])) * 100}%;width:${((b[2] - b[0]) / (region[2] - region[0])) * 100}%;height:${((b[3] - b[1]) / (region[3] - region[1])) * 100}%`;
    band.append(hl);
  }
  return band;
}

/**
 * Shown before a volunteer's first line, and on request: what to do, the conventions, and that checks exist. The text
 * is the volunteer introduction as reviewed for the launch; it stays as written (Hebrew, with an English summary).
 */
function onboarding(onStart: () => void): HTMLElement {
  return h(
    "section",
    { class: "card onboard", lang: "he", dir: "rtl" },
    h("h2", {}, "ברוכים הבאים לבדיקת שורות"),
    h(
      "ol",
      {},
      h("li", {}, "בכל פעם מוצגת שורה אחת מסריקה, ומתחתיה הטקסט שזוהה בה."),
      h("li", {}, "אם הטקסט זהה לשורה המודפסת, אות באות וסימן בסימן: \"נכון\". אם לא: \"תיקון\", ומקלידים את השורה כמו שהיא מודפסת."),
      h("li", {}, "בדפוס יש ניקוד: \"בדפוס יש ניקוד\", ומקלידים את האותיות בלבד. אי אפשר לקרוא: \"לא קריא\". השורה המסומנת לא נמצאת בעמוד: \"לא בעמוד\"."),
      h("li", {}, "כל שורה נבדקת בנפרד בידי כמה מתנדבים, וההחלטה שלכם סופית. לא רואים כאן החלטות של אחרים."),
      h("li", {}, "חלק מהשורות הן שורות בדיקה שהתשובה עליהן ידועה, ואין סימן שמבדיל ביניהן לבין שאר השורות."),
    ),
    h("p", { lang: "en", dir: "ltr", class: "muted small" }, "One printed line at a time: mark it correct, or edit it to match the print exactly; print has niqqud (type the letters only), unreadable, or not on the page. Several volunteers check each line independently, and your decision is final. Some lines are checks with a known answer, unmarked."),
    h("h3", {}, "מוסכמות הקלדה / Typing conventions"),
    h("dl", { class: "small conventions" }, ...LINE_CONVENTIONS.flatMap(([what, type]) => [h("dt", {}, what), h("dd", { dir: "auto" }, type)])),
    h("button", { type: "button", class: "act primary", onclick: onStart }, "מתחילים / Start"),
  );
}

/** `startAt` opens one line first (link #p/<id>), if it is open to this reviewer; then the queue continues. */
export function lineConsensusView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number): ReviewScreen {
  const root = h("div", { class: "taskroot" });
  const desktopMq = matchMedia(DESKTOP_QUERY);
  let current: ProposalView | null = null;
  let progress: Progress = batch.progress;
  let editing: HTMLTextAreaElement | null = null;
  let busy = false;
  let ready = false;
  // A desktop starts at the largest ink height, so a long line fills the column as one strip (the zoom buttons step
  // down); a phone starts at its two-piece size.
  let zoom = desktopMq.matches ? LINE_HEIGHTS.length - 1 : 2;
  let fitWidth = false;
  let introDone = false;
  let keysOpen = false;
  let failure: Failure | null = null;
  let saveState: SaveState = null;
  let page: PageColumn | null = null;
  const view = (): LineConsensusView | null => (current && current.view.kind === "line_consensus" ? current.view : null);
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
    failure = null;
    if (!current) return renderDone();
    if (!introDone && progress.decidedByMe === 0) return renderIntro();
    render();
  }

  async function open(id: number): Promise<void> {
    const res = await get<{ proposal: ProposalView }>(`/api/proposals/${id}`);
    current = res.proposal;
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
    if (current.mine) return status(t("mine_final_note"));
    if (!ready && value !== "unreadable") return status(t("img_loading"));
    busy = true;
    const id = current.id;
    markSaving(root, value);
    renderSaveState(q(".savestate"), (saveState = "saving"));
    try {
      await send(id, value, text);
      dropPending(id);
      clearDraft(id);
      saveState = "saved";
      await loadNext();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      if (err instanceof ApiFailure && err.code === "decided") {
        // Already decided (another tab, or a resend): move on.
        dropPending(id);
        await loadNext().catch(failScreen);
        return;
      }
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

  /** Resend the decisions kept on this device, once. A line already decided is dropped from the store. */
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
          if (err instanceof ApiFailure && err.code === "decided") dropPending(p.proposalId);
          else if (!keepable(failureKind(err, navigator.onLine))) dropPending(p.proposalId);
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

  function closeEditor(): void {
    editing = null;
    body.remove("editing");
    const box = q(".editbox");
    if (box) {
      box.replaceChildren();
      box.hidden = true;
    }
  }

  function startEdit(pointedFirst = false): void {
    const v = view();
    setMoreOpen(root, false);
    if (!v || !current || current.mine) return;
    if (editing) return editing.focus();
    const p = current;
    const box = q(".editbox")!;
    const area = h("textarea", { dir: "rtl", lang: "he", rows: 3, spellcheck: "false", autocomplete: "off", autocapitalize: "off", maxlength: 1000, "aria-label": t("edit_title") });
    area.value = readDraft(p.id) ?? v.prefill;
    const pointed = h("input", { type: "checkbox", id: "lc-pointed" }) as HTMLInputElement;
    pointed.checked = pointedFirst;
    const changes = h("p", { class: "changes", role: "status" });
    const preview = h("div", { class: "preview desktop-only" });
    const update = () => {
      if (/[\r\n]/.test(area.value)) area.value = area.value.replace(/[\r\n]+/g, " ");
      writeDraft(p.id, area.value);
      const cmp = compare(v.prefill, area.value, "", "");
      const del = cmp.current.querySelectorAll("mark.del");
      const ins = cmp.proposed.querySelectorAll("mark.ins");
      changes.replaceChildren(
        ...(del.length || ins.length
          ? [`${t("changed")} `, h("bdi", { dir: "rtl" }, ...Array.from(del, (m) => h("del", {}, m.textContent ?? "")), del.length && ins.length ? " ← " : "", ...Array.from(ins, (m) => h("ins", {}, m.textContent ?? "")))]
          : []),
      );
      preview.replaceChildren(cmp.codes);
    };
    const save = () => {
      const text = area.value;
      if (pointed.checked && hasNiqqud(text)) return status(t("nq_letters"));
      void act(pointed.checked ? "print_has_niqqud" : "edit", text);
    };
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
      } else if (e.key === "Enter") e.preventDefault();
      else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    box.replaceChildren(
      area,
      changes,
      h(
        "div",
        { class: "edittools" },
        h("button", { type: "button", class: "act quiet", onclick: () => ((area.value = v.prefill), update(), area.focus()) }, icon("reset", { sm: true }), t("reset")),
        h("label", { class: "check", for: "lc-pointed" }, pointed, t("nq")),
      ),
      preview,
      h(
        "div",
        { class: "savebar" },
        h("button", { type: "button", class: "act primary", "data-value": "edit", onclick: save }, h("span", {}, t("save")), " ", h("kbd", {}, "Ctrl+Enter")),
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

  function renderStrip(): void {
    const v = view();
    const holder = q(".linebox .strip");
    if (!v || !holder) return;
    if (!v.crop || !v.crop.box) {
      ready = true;
      holder.replaceChildren(h("p", { class: "muted" }, t("no_box")));
      return;
    }
    const width = Math.max(200, holder.clientWidth || root.clientWidth || 360);
    const pieces = stripPieces(v.crop, v.crop.box, width, desktop(), fitWidth);
    holder.replaceChildren(lineStrip(v.crop, v.crop.box, LINE_HEIGHTS[zoom]!, width, () => (ready = true), pieces, t("line_on_scan")));
    const band = q(".ctxbox .bandholder");
    if (band && v.crop && v.context) band.replaceChildren(bandImage(v.crop, v.context, Math.max(200, band.clientWidth || 360)));
  }

  function setZoom(step: number): void {
    zoom = Math.max(0, Math.min(LINE_HEIGHTS.length - 1, zoom + step));
    renderStrip();
  }

  function chips(v: LineConsensusView): HTMLElement | null {
    // Look-here hints: where to look, never a reading (design CLASSMAP: one .tag.look style for all of them).
    const list = [
      v.tierA ? t("look") : null,
      v.bidiRisk ? t("digits") : null,
      v.aiDisagrees ? t("ai_differs") : null,
      v.aiMissingNear ? t("ai_missing") : null,
    ].filter((c): c is string => c !== null);
    return list.length ? h("div", { class: "chips" }, ...list.map((c) => h("span", { class: "tag look" }, icon("flag", { sm: true }), c))) : null;
  }

  const KEYS = (): [string, string][] => [
    ["Enter · 1", t("correct")],
    ["E · 2", t("fix")],
    ["N", t("niqqud")],
    ["S · 5", t("skip")],
    ["+ / −", t("zoom_in")],
    ["P", t("page")],
    ["Esc", t("close")],
  ];

  function render(): void {
    const p = current!;
    const v = view();
    if (!v) throw new Error(`lineConsensusView cannot show ${p.view.kind}`);
    closeEditor();
    ready = false;
    keysOpen = false;
    const option = (value: string) => p.options.find((o) => o.value === value);
    const mine = p.mine ? option(p.mine.value) : undefined;
    hooks.where?.(t("c_where", { n: progress.decidedByMe }));
    page = pageColumn(v.page, p.itemTitle, [h("bdi", {}, v.attribution), " · ", `${t("licence")}: `, h("bdi", {}, v.textLicense)], () => undefined, () => q<HTMLButtonElement>(".ctxbox .open")?.focus());
    const decided = p.mine !== null;
    const more = [
      moreButton("print_has_niqqud", t("niqqud"), t("niqqud_sub"), "niqqud", "N", () => startEdit(true)),
      moreButton("unreadable", t("unread"), t("unread_sub"), "unreadable", "", () => (setMoreOpen(root, false), void act("unreadable"))),
      moreButton("not_on_page", t("not_on"), t("not_on_sub"), "not-on-page", "", () => (setMoreOpen(root, false), void act("not_on_page"))),
      moreButton("skip", t("skip"), t("skip_sub"), "skip", "S", () => void doSkip()),
    ];
    const work = h(
      "div",
      { class: "review lineverify consensus" },
      h("p", { class: "ask" }, t("ask")),
      h("div", { class: "linebox" }, h("div", { class: "strip" }), cropBar(fitWidth, (fit) => ((fitWidth = fit), render()))),
      h("div", { class: "txt cand", dir: "rtl", lang: "he" }, ...candidateNodes([{ text: v.prefill, attention: false }])),
      h(
        "div",
        { class: "slot" },
        chips(v),
        failure ? failedNotice(failure, () => (failure!.kept ? void resendKept() : void act(failure!.value, failure!.text))) : null,
        mine ? h("p", { class: "mine" }, t("mine", { v: mine.label[lang()] }), p.mine?.text ? ` («${p.mine.text}»)` : "", ` · ${t("mine_final_note")}`) : null,
        h("p", { class: "msg", role: "status" }),
      ),
      h("div", { class: "editbox", hidden: true }),
      contextBand(h("div", { class: "bandholder" }), Boolean(v.page), () => page?.open()),
      ...dock(
        [answerButton("correct", t("correct"), "Enter", () => void act("correct"), true), answerButton("edit", t("fix"), "E", () => startEdit())],
        more,
        [
          ...zoomButtons(setZoom),
          h("button", { type: "button", class: "act quiet", onclick: renderIntro }, t("help")),
          decided ? h("button", { type: "button", class: "act quiet", onclick: () => void loadNext().catch(failScreen) }, t("to_queue")) : null,
        ],
        () => root,
      ),
    );
    mount(root, progressLine(progress), h("div", { class: "deck" }, work, page.el));
    for (const b of root.querySelectorAll<HTMLButtonElement>(".dock .actions .act")) b.disabled = decided;
    renderSaveState(q(".savestate"), saveState);
    renderStrip();
    q<HTMLButtonElement>(".dock .act.primary:not(:disabled)")?.focus({ preventScroll: true });
  }

  function renderIntro(): void {
    hooks.where?.(null);
    mount(
      root,
      h(
        "div",
        { class: "review" },
        onboarding(() => {
          introDone = true;
          if (current) render();
          else void loadNext().catch(failScreen);
        }),
      ),
    );
  }

  function renderDone(): void {
    hooks.where?.(null);
    mount(
      root,
      stateScreen(
        "exact",
        t("done_h"),
        null,
        progress.skippedByMe ? h("button", { type: "button", class: "act primary", onclick: () => void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`).then(loadNext).catch(failScreen) }, t("done_skips", { n: progress.skippedByMe })) : null,
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
    if (!current || current.view.kind !== "line_consensus" || !q(".dock")) return;
    if (e.repeat) return e.preventDefault();
    if (e.key === "?") {
      e.preventDefault();
      keysOpen = !keysOpen;
      q(".keys-panel")?.remove();
      if (keysOpen) q(".slot")?.prepend(keysPanel(KEYS()));
      return;
    }
    const actions: Record<string, () => void> = {
      Enter: () => void act("correct"),
      NumpadEnter: () => void act("correct"),
      Digit1: () => void act("correct"),
      KeyE: () => startEdit(),
      Digit2: () => startEdit(),
      KeyN: () => startEdit(true),
      KeyS: () => void doSkip(),
      Digit5: () => void doSkip(),
      Equal: () => setZoom(1),
      NumpadAdd: () => setZoom(1),
      Minus: () => setZoom(-1),
      NumpadSubtract: () => setZoom(-1),
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
  (startAt === undefined ? resendKept().then(loadNext) : open(startAt).catch(() => loadNext())).catch(failScreen);
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
