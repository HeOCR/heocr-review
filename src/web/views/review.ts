import type { BatchSummary, NextResponse, Progress, ProposalView, TextCorrectionView } from "../../shared/api";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { compare, textLine } from "../text";
import { diffText, sides } from "../../shared/diff";
import { failureHandler, prefetch, progressBar, type ReviewHooks, type ReviewScreen } from "./common";
import { viewer, type Viewer } from "./viewer";

/** `startAt` opens one proposal first (link #p/<id>); then the queue continues. */
export function reviewView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number): ReviewScreen {
  const root = h("div", { class: "review" });
  const history: number[] = [];
  let current: ProposalView | null = null;
  let progress: Progress = batch.progress;
  let viewerApi: Viewer | null = null;
  let editing: HTMLTextAreaElement | null = null;
  let busy = false;

  const fail = failureHandler(root, hooks);

  async function loadNext(): Promise<void> {
    const res = await get<NextResponse>(`/api/batches/${encodeURIComponent(batch.id)}/next`);
    progress = res.progress;
    prefetch(res.prefetch);
    current = res.proposal;
    if (current) renderProposal(current);
    else renderDone();
  }

  async function open(id: number): Promise<void> {
    const res = await get<{ proposal: ProposalView }>(`/api/proposals/${id}`);
    current = res.proposal;
    renderProposal(current, true);
  }

  async function act(value: string, text?: string): Promise<void> {
    if (!current || busy) return;
    busy = true;
    const id = current.id;
    try {
      const body = text === undefined ? { value } : { value, text };
      try {
        await post(`/api/proposals/${id}/decision`, body);
      } catch (err) {
        if (!(err instanceof ApiFailure && err.code === "terms_required")) throw err;
        await hooks.needTerms();
        await post(`/api/proposals/${id}/decision`, body);
      }
      if (history[history.length - 1] !== id) history.push(id);
      await loadNext();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  async function doSkip(): Promise<void> {
    if (!current || busy) return;
    busy = true;
    try {
      await post(`/api/proposals/${current.id}/skip`);
      history.push(current.id);
      await loadNext();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  function back(): void {
    const id = history.pop();
    if (id !== undefined) open(id).catch(fail);
  }

  function startEdit(): void {
    if (!current || editing) return;
    const v = current.view as TextCorrectionView;
    const box = root.querySelector(".editbox") as HTMLElement;
    const area = h("textarea", { dir: "rtl", lang: "he", rows: 2, spellcheck: "false", maxlength: 1000, "aria-label": "הטקסט המתוקן" });
    area.value = current.mine?.value === "edited" && current.mine.text !== null ? current.mine.text : v.proposed;
    const preview = h("div", { class: "preview" });
    const update = () => {
      const { after } = sides(diffText(v.current, area.value));
      preview.replaceChildren(h("span", { class: "lab" }, "תצוגה:"), textLine(v.contextBefore, after.filter((s) => s.text), v.contextAfter, "edit"));
    };
    area.addEventListener("input", update);
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    const save = () => {
      const text = area.value;
      cancel();
      void act("edited", text);
    };
    const cancel = () => {
      editing = null;
      box.replaceChildren();
      box.hidden = true;
    };
    box.replaceChildren(
      area,
      preview,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "primary", onclick: save }, "שמירת העריכה ", h("kbd", { dir: "ltr" }, "Ctrl+Enter")),
        h("button", { type: "button", onclick: cancel }, "ביטול ", h("kbd", { dir: "ltr" }, "Esc")),
      ),
    );
    box.hidden = false;
    editing = area;
    update();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function renderProposal(p: ProposalView, revisiting = false): void {
    editing = null;
    if (p.view.kind !== "text_correction") throw new Error(`reviewView cannot show ${p.view.kind}`);
    const v = p.view;
    const cmp = compare(v.current, v.proposed, v.contextBefore, v.contextAfter);
    viewerApi = viewer(v.crop, v.page);
    const option = (value: string) => p.options.find((o) => o.value === value);
    const btn = (value: string, key: string, cls: string, onclick: () => void, label: string) =>
      h("button", { type: "button", class: `act ${cls}`, onclick, "data-value": value }, label, h("kbd", { dir: "ltr" }, key));
    const mineLabel = p.mine ? p.options.find((o) => o.value === p.mine!.value)?.label.he ?? p.mine.value : null;
    mount(
      root,
      progressBar(progress),
      h(
        "article",
        { class: "card proposal" },
        h(
          "header",
          { class: "meta" },
          h("span", { class: "tag" }, v.category.label.he),
          h("span", { class: `tag conf-${v.confidence.id}` }, `ביטחון ${v.confidence.label.he}`),
          h("span", { class: "muted small title", dir: "auto" }, p.itemTitle),
        ),
        viewerApi.el,
        h(
          "div",
          { class: "texts" },
          h("div", { class: "row" }, h("span", { class: "lab" }, "כעת:"), cmp.current),
          h("div", { class: "row" }, h("span", { class: "lab" }, "מוצע:"), cmp.proposed),
          h("div", { class: "row" }, h("span", { class: "lab" }, ""), cmp.codes),
        ),
        h("p", { class: "note", dir: "ltr", lang: "en" }, h("span", { class: "muted" }, "Agent note: "), v.note),
        revisiting && mineLabel ? h("p", { class: "mine" }, `ההחלטה שלך: ${mineLabel}`, p.mine?.text ? ` («${p.mine.text}»)` : "") : null,
        h("div", { class: "editbox", hidden: true }),
        h("p", { class: "msg", role: "status" }),
      ),
      h(
        "nav",
        { class: "actions" },
        btn("accepted", "A", "ok", () => void act("accepted"), option("accepted")?.label.he ?? "קבלה"),
        btn("rejected", "R", "bad", () => void act("rejected"), option("rejected")?.label.he ?? "דחייה"),
        btn("edited", "E", "edit", startEdit, option("edited")?.label.he ?? "עריכה"),
        btn("skip", "S", "skip", () => void doSkip(), "דילוג"),
      ),
      h(
        "div",
        { class: "subnav" },
        h("button", { type: "button", class: "small", onclick: back, disabled: history.length === 0 }, "→ הקודם ", h("kbd", { dir: "ltr" }, "B")),
        revisiting ? h("button", { type: "button", class: "small", onclick: () => void loadNext().catch(fail) }, "לתור ←") : null,
        h(
          "p",
          { class: "keys muted small" },
          "קיצורים: ",
          ...[
            ["A", "קבלה"],
            ["R", "דחייה"],
            ["E", "עריכה"],
            ["S", "דילוג"],
            ["B", "הקודם"],
            ["+/−", "זום"],
            ["P", "עמוד מלא"],
          ].flatMap(([k, t]) => [h("kbd", { dir: "ltr" }, k!), ` ${t} · `]),
        ),
      ),
    );
  }

  function renderDone(): void {
    viewerApi = null;
    mount(
      root,
      progressBar(progress),
      h(
        "section",
        { class: "card done" },
        h("h2", {}, "אין עוד הצעות בשבילך כרגע. תודה רבה!"),
        h("p", { lang: "en", dir: "ltr", class: "muted" }, "Nothing left for you right now. Thank you!"),
        progress.skippedByMe
          ? h(
              "button",
              {
                type: "button",
                onclick: () =>
                  void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`)
                    .then(loadNext)
                    .catch(fail),
              },
              `חזרה ל-${progress.skippedByMe} ההצעות שדילגת עליהן`,
            )
          : null,
        history.length ? h("button", { type: "button", onclick: back }, "→ חזרה להחלטה האחרונה") : null,
        h("p", { class: "msg", role: "status" }),
      ),
    );
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
    if (!current) return;
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
      Equal: () => viewerApi?.zoomIn(),
      NumpadAdd: () => viewerApi?.zoomIn(),
      KeyZ: () => viewerApi?.zoomIn(),
      Minus: () => viewerApi?.zoomOut(),
      NumpadSubtract: () => viewerApi?.zoomOut(),
      KeyX: () => viewerApi?.zoomOut(),
      KeyP: () => viewerApi?.togglePage(),
    };
    const fn = actions[e.code];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };
  document.addEventListener("keydown", onKey);
  mount(root, h("p", { class: "muted" }, "טוען…"));
  (startAt === undefined ? loadNext() : open(startAt)).catch(fail);
  return { el: root, dispose: () => document.removeEventListener("keydown", onKey) };
}
