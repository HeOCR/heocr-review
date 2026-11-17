/**
 * The volunteer line review screen (task type line_consensus), phone first: the printed line large, its pre-fill under
 * it, five actions as big buttons, and the page around the line on request. A volunteer never sees another
 * volunteer's decision or any count of others' work; decisions are final, so there is no "back". The maintainer gets
 * the same screen for the lines that went to them, from the pre-fill only.
 * Keys: Enter correct · E edit · N print has niqqud · U unreadable · X not on the page · S skip · +/− zoom · P page.
 */
import type { BatchSummary, LineConsensusView, NextResponse, Progress, ProposalView } from "../../shared/api";
import { hasNiqqud } from "../../shared/niqqud";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { compare } from "../text";
import { failureHandler, prefetch, progressBar, type ReviewHooks, type ReviewScreen } from "./common";
import { LINE_CONVENTIONS } from "./conventions";
import { candidateNodes, lineStrip } from "./line";
import { viewer } from "./viewer";

const LINE_HEIGHTS = [40, 52, 66, 84, 108, 140];

const KEYS: [string, string, string][] = [
  ["Enter", "נכון", "correct"],
  ["E", "תיקון", "edit"],
  ["N", "בדפוס יש ניקוד", "print has niqqud"],
  ["U", "לא קריא", "unreadable"],
  ["X", "לא בעמוד", "not on the page"],
  ["S", "דילוג", "skip"],
  ["+/−", "זום", "zoom"],
  ["P", "עמוד מלא", "page"],
];

/** Shown before a volunteer's first line, and on request: what to do, the conventions, and that checks exist. */
function onboarding(onStart: () => void): HTMLElement {
  return h(
    "section",
    { class: "card onboard" },
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
    h("dl", { class: "small" }, ...LINE_CONVENTIONS.flatMap(([what, type]) => [h("dt", {}, what), h("dd", { dir: "auto" }, type)])),
    h("button", { type: "button", class: "primary", onclick: onStart }, "מתחילים / Start"),
  );
}

/** `startAt` opens one line first (link #p/<id>), if it is open to this reviewer; then the queue continues. */
export function lineConsensusView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number): ReviewScreen {
  const root = h("div", { class: "review lineverify consensus" });
  let current: ProposalView | null = null;
  let progress: Progress = batch.progress;
  let editing: HTMLTextAreaElement | null = null;
  let busy = false;
  let ready = false;
  let zoom = matchMedia("(max-width: 520px)").matches ? 0 : 2;
  let showPage = false;
  let introDone = false;
  const fail = failureHandler(root, hooks);
  const view = (): LineConsensusView | null => (current && current.view.kind === "line_consensus" ? current.view : null);
  const status = (text: string) => {
    const msg = root.querySelector(".msg");
    if (msg) msg.textContent = text;
  };

  async function loadNext(): Promise<void> {
    const res = await get<NextResponse>(`/api/batches/${encodeURIComponent(batch.id)}/next`);
    progress = res.progress;
    prefetch(res.prefetch);
    current = res.proposal;
    if (!current) return renderDone();
    if (!introDone && progress.decidedByMe === 0) return renderIntro();
    render();
  }

  async function open(id: number): Promise<void> {
    const res = await get<{ proposal: ProposalView }>(`/api/proposals/${id}`);
    current = res.proposal;
    render();
  }

  async function act(value: string, text?: string): Promise<void> {
    if (!current || busy) return;
    if (current.mine) return status("כבר החלטת על השורה הזאת. / You already decided this line.");
    if (!ready && value !== "unreadable") return status("התמונה עוד נטענת. / The image is still loading.");
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
      await loadNext();
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "decided") await loadNext().catch(fail);
      else fail(err);
    } finally {
      busy = false;
    }
  }

  async function doSkip(): Promise<void> {
    if (!current || busy) return;
    busy = true;
    try {
      await post(`/api/proposals/${current.id}/skip`);
      await loadNext();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  function startEdit(pointedFirst = false): void {
    const v = view();
    if (!v || editing || !current || current.mine) return;
    const box = root.querySelector(".editbox") as HTMLElement;
    const area = h("textarea", {
      dir: "rtl",
      lang: "he",
      rows: 2,
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      maxlength: 1000,
      "aria-label": "השורה כמו שהיא מודפסת / the line as printed",
    });
    area.value = v.prefill;
    const pointed = h("input", { type: "checkbox", id: "lc-pointed" }) as HTMLInputElement;
    pointed.checked = pointedFirst;
    const pointedRow = h("label", { class: "row check", for: "lc-pointed" }, pointed, " בדפוס יש ניקוד: אותיות בלבד, בלי ניקוד / Print has niqqud: letters only");
    const preview = h("div", { class: "preview texts" });
    const update = () => {
      if (/[\r\n]/.test(area.value)) area.value = area.value.replace(/[\r\n]+/g, " ");
      const cmp = compare(v.prefill, area.value, "", "");
      preview.replaceChildren(
        h("div", { class: "row" }, h("span", { class: "lab" }, "זוהה:"), cmp.current),
        h("div", { class: "row" }, h("span", { class: "lab" }, "שלך:"), cmp.proposed),
        h("div", { class: "row" }, h("span", { class: "lab" }, ""), cmp.codes),
      );
    };
    const cancel = () => {
      editing = null;
      box.replaceChildren();
      box.hidden = true;
    };
    const save = () => {
      const text = area.value;
      if (pointed.checked && hasNiqqud(text)) return status("עם \"בדפוס יש ניקוד\" מקלידים אותיות בלבד. / Type letters only.");
      cancel();
      void act(pointed.checked ? "print_has_niqqud" : "edit", text);
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
      pointedRow,
      preview,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "primary", onclick: save }, "שמירה / Save ", h("kbd", { dir: "ltr" }, "Ctrl+Enter")),
        h("button", { type: "button", onclick: cancel }, "ביטול / Cancel ", h("kbd", { dir: "ltr" }, "Esc")),
      ),
    );
    box.hidden = false;
    editing = area;
    update();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function renderStrip(): void {
    const v = view();
    const holder = root.querySelector(".linebox") as HTMLElement | null;
    if (!v || !holder) return;
    if (!v.crop || !v.crop.box) {
      ready = true;
      holder.replaceChildren(h("p", { class: "muted" }, "לשורה הזאת אין מיקום בסריקה: חפשו אותה בעמוד המלא. / No box for this line: find it on the full page."));
      return;
    }
    const width = Math.max(200, holder.clientWidth || root.clientWidth || 360);
    holder.replaceChildren(lineStrip(v.crop, v.crop.box, LINE_HEIGHTS[zoom]!, width, () => (ready = true)));
  }

  function renderContext(): void {
    const v = view();
    const holder = root.querySelector(".ctxbox") as HTMLElement | null;
    if (!v || !holder) return;
    const toggle = h(
      "button",
      { type: "button", class: "small", onclick: togglePage, disabled: !v.page },
      showPage ? "חזרה להקשר / Back to context " : "העמוד המלא / Full page ",
      h("kbd", { dir: "ltr" }, "P"),
    );
    if (showPage && v.page) {
      holder.replaceChildren(viewer(null, v.page).el, h("div", { class: "row" }, toggle));
      return;
    }
    const c = v.crop;
    const band = c
      ? h(
          "div",
          { class: "frame ctxband" },
          h("img", { src: c.url, width: c.width, height: c.height, alt: "השורה עם השורות שלפניה ואחריה / the line with its neighbours", decoding: "async", draggable: "false" }),
          c.box
            ? h("div", {
                class: "hl",
                style: `left:${c.box[0] * 100}%;top:${c.box[1] * 100}%;width:${(c.box[2] - c.box[0]) * 100}%;height:${(c.box[3] - c.box[1]) * 100}%`,
              })
            : null,
        )
      : null;
    if (band && c) band.style.width = `min(100%, ${Math.round((150 * c.width) / Math.max(1, c.height))}px)`;
    holder.replaceChildren(h("div", { class: "ctxscroll", dir: "ltr" }, band), h("div", { class: "row" }, toggle));
  }

  function togglePage(): void {
    if (!view()?.page) return;
    showPage = !showPage;
    renderContext();
  }

  function setZoom(step: number): void {
    zoom = Math.max(0, Math.min(LINE_HEIGHTS.length - 1, zoom + step));
    renderStrip();
  }

  function hints(v: LineConsensusView): HTMLElement | null {
    const chips = [
      v.tierA ? h("span", { class: "tag look", title: "Look here: check this line closely" }, "בדקו היטב") : null,
      v.bidiRisk ? h("span", { class: "tag look", title: "Digits or brackets: check their order" }, "ספרות/סוגריים") : null,
      v.aiDisagrees ? h("span", { class: "tag ai", title: "Claude read this line differently (its reading is not shown)" }, "קריאה אחרת (Claude)") : null,
      v.aiMissingNear ? h("span", { class: "tag ai", title: "Claude saw text near here that is missing" }, "חסר טקסט לידה? (Claude)") : null,
    ].filter((c): c is HTMLElement => c !== null);
    return chips.length ? h("div", { class: "chips" }, ...chips) : null;
  }

  function render(): void {
    const p = current!;
    const v = view();
    if (!v) throw new Error(`lineConsensusView cannot show ${p.view.kind}`);
    editing = null;
    ready = false;
    showPage = false;
    const option = (value: string) => p.options.find((o) => o.value === value);
    const btn = (value: string, key: string, cls: string, onclick: () => void) => {
      const o = option(value);
      return h(
        "button",
        { type: "button", class: `act ${cls}`, onclick, "data-value": value, title: o?.label.en ?? value, disabled: p.mine !== null },
        h("span", {}, o?.label.he ?? value),
        h("kbd", { dir: "ltr" }, key),
      );
    };
    const mine = p.mine ? option(p.mine.value) : undefined;
    mount(
      root,
      progressBar(progress),
      h(
        "article",
        { class: "card proposal" },
        h("header", { class: "meta" }, h("span", { class: "tag", title: v.series.label.en }, v.series.label.he), h("span", { class: "muted small title", dir: "auto" }, p.itemTitle)),
        h(
          "p",
          { class: "ask" },
          "האם הטקסט זהה בדיוק לשורה המסומנת, אות באות וסימן בסימן?",
          h("span", { class: "muted small block", lang: "en", dir: "ltr" }, "Is the text exactly the marked line, letter by letter and mark by mark?"),
        ),
        h("div", { class: "linebox" }),
        h("div", { class: "txt cand", dir: "rtl", lang: "he" }, ...candidateNodes([{ text: v.prefill, attention: false }])),
        hints(v),
        mine ? h("p", { class: "mine" }, `ההחלטה שלך: ${mine.label.he}`, p.mine?.text ? ` («${p.mine.text}»)` : "", " · החלטה סופית.") : null,
        h("div", { class: "editbox", hidden: true }),
        h("p", { class: "msg", role: "status" }),
        h("div", { class: "ctxbox" }),
        h("p", { class: "attrib muted small" }, h("bdi", { class: "block", dir: "auto" }, v.attribution), h("span", { class: "block" }, "רישיון הטקסט / Text licence: ", h("bdi", { dir: "auto" }, v.textLicense))),
      ),
      h(
        "nav",
        { class: "actions six" },
        btn("correct", "Enter", "ok", () => void act("correct")),
        btn("edit", "E", "edit", () => startEdit()),
        btn("print_has_niqqud", "N", "ok pointed", () => startEdit(true)),
        btn("unreadable", "U", "bad", () => void act("unreadable")),
        btn("not_on_page", "X", "bad", () => void act("not_on_page")),
        h("button", { type: "button", class: "act skip", onclick: () => void doSkip(), title: "Skip" }, h("span", {}, "דילוג"), h("kbd", { dir: "ltr" }, "S")),
      ),
      h(
        "div",
        { class: "subnav" },
        h("button", { type: "button", class: "small", onclick: () => setZoom(-1), "aria-label": "הקטנה / zoom out" }, "−"),
        h("button", { type: "button", class: "small", onclick: () => setZoom(1), "aria-label": "הגדלה / zoom in" }, "+"),
        h("button", { type: "button", class: "small", onclick: renderIntro }, "הסבר ומוסכמות / Help"),
        p.mine ? h("button", { type: "button", class: "small", onclick: () => void loadNext().catch(fail) }, "לתור ←") : null,
        h("p", { class: "keys muted small" }, "קיצורים: ", ...KEYS.flatMap(([k, t, en]) => [h("kbd", { dir: "ltr", title: en }, k), ` ${t} · `])),
      ),
    );
    renderStrip();
    renderContext();
  }

  function renderIntro(): void {
    mount(
      root,
      onboarding(() => {
        introDone = true;
        if (current) render();
        else void loadNext().catch(fail);
      }),
    );
  }

  function renderDone(): void {
    mount(
      root,
      progressBar(progress),
      h(
        "section",
        { class: "card done" },
        h("h2", {}, "אין עוד שורות בשבילך כרגע. תודה רבה!"),
        h("p", { lang: "en", dir: "ltr", class: "muted" }, "No lines left for you right now. Thank you!"),
        progress.skippedByMe
          ? h("button", { type: "button", onclick: () => void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`).then(loadNext).catch(fail) }, `חזרה ל-${progress.skippedByMe} השורות שדילגת עליהן`)
          : null,
        h("p", { class: "msg", role: "status" }),
      ),
    );
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
    if (target && (target.tagName === "BUTTON" || target.tagName === "A") && (e.key === "Enter" || e.key === " ")) return;
    if (!current || current.view.kind !== "line_consensus" || !root.querySelector(".proposal")) return;
    if (e.repeat) return e.preventDefault();
    const actions: Record<string, () => void> = {
      Enter: () => void act("correct"),
      NumpadEnter: () => void act("correct"),
      Digit1: () => void act("correct"),
      KeyE: () => startEdit(),
      Digit2: () => startEdit(),
      KeyN: () => startEdit(true),
      KeyU: () => void act("unreadable"),
      Digit3: () => void act("unreadable"),
      KeyX: () => void act("not_on_page"),
      Digit4: () => void act("not_on_page"),
      KeyS: () => void doSkip(),
      Digit5: () => void doSkip(),
      Equal: () => setZoom(1),
      NumpadAdd: () => setZoom(1),
      Minus: () => setZoom(-1),
      NumpadSubtract: () => setZoom(-1),
      KeyP: togglePage,
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
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  mount(root, h("p", { class: "muted" }, "טוען… / Loading…"));
  (startAt === undefined ? loadNext() : open(startAt).catch(() => loadNext())).catch(fail);
  return {
    el: root,
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    },
  };
}
