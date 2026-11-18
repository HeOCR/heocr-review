/**
 * The handwriting transcription screen (task type line_transcribe), phone first: the handwritten line large, an empty
 * box to type it in, and the page around it on request. Nothing machine-made is ever shown (h_eval_v1 amendment 1).
 * A volunteer never sees another transcriber's text; transcriptions are final, so there is no "back".
 *
 * Languages: other_hebrew_script lines (Judeo-Arabic, Ladino, ... in Hebrew script) are served only when the
 * volunteer ticks, for this session, that they read the language. The choice stays in this browser tab
 * (sessionStorage) and goes with each request for the next line; the server never stores it.
 *
 * Box problems (the boxes are machine-made and fragment on dense or faded pages): a piece of a split line ("part of a
 * line typed in another box": the whole line is typed in its first, rightmost piece), a false box ("no text"), a box
 * over two lines ("box doesn't hold one line"), and a text line no box covers ("a line here has no box": a report
 * on the page for the maintainer, which decides nothing about the line in front of you).
 *
 * Keys outside the text box: T type · S skip · +/− zoom · P page. Inside it: Ctrl+Enter save · Esc leave the box.
 * The final actions have buttons only, so a stray key in a Hebrew layout never makes one.
 */
import type { BatchSummary, LineTranscribeView, NextResponse, Progress, ProposalView } from "../../shared/api";
import { LANGUAGE_LABELS } from "../../shared/languages";
import { hasNiqqud } from "../../shared/niqqud";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { failureHandler, prefetch, progressBar, type ReviewHooks, type ReviewScreen } from "./common";
import { contextBand } from "./consensus";
import { LINE_CONVENTIONS } from "./conventions";
import { lineStrip } from "./line";
import { viewer } from "./viewer";

const LINE_HEIGHTS = [48, 64, 84, 108, 140, 180];
/** Shown on every line (lead, 2026-11-18): the boxes around the marked one are outlined in the band below it. */
const SPLIT_RULE = {
  he: "אם במסגרת הזאת יש תחילת שורה (החלק הימני שלה) שממשיכה במסגרות אחרות, הקלידו את כל השורה. אם יש בה חלק מאוחר יותר של השורה, בחרו \"המשך שורה\".",
  en: "If this box holds the start (rightmost part) of a line that continues in other boxes, type the whole line. If it holds a later part, choose 'continued'.",
};
const LANGS_KEY = "heocr.transcribe.languages";
/** Latin letters in a Hebrew-script transcription usually mean the keyboard is in the wrong layout. */
const LATIN = /[A-Za-z]/;

const KEYS: [string, string, string][] = [
  ["T", "הקלדה", "type"],
  ["S", "דילוג", "skip"],
  ["+/−", "זום", "zoom"],
  ["P", "עמוד מלא", "page"],
];

/** Handwriting rows added to the sheet (provisional until eval registers H conventions). */
const H_CONVENTIONS: [string, string][] = [
  ["כתיב", "בדיוק כמו שכתוב, גם כתיב חסר, קיצורים וטעויות. לא מתקנים ולא משלימים"],
  ["קטע שאי אפשר לקרוא בתוך שורה", "[?] (כפתור), פעם אחת לכל קטע, בכל אורך"],
  ["כל השורה לא קריאה", "הכפתור \"כל השורה לא קריאה\""],
  ["שורה שמחולקת לכמה מסגרות", "מקלידים את כל השורה במסגרת הראשונה שלה (הימנית ביותר). בשאר המסגרות: \"המשך שורה\""],
  ["מסגרת על כתם, חותמת או דיו שעבר מהצד השני", "\"אין כאן טקסט\""],
  ["מסגרת על שתי שורות", "\"המסגרת לא מכילה שורה אחת\""],
  ["שורה בלי מסגרת", "\"יש כאן שורה בלי מסגרת\", ואז ממשיכים להקליד את השורה המסומנת"],
  ["שפה אחרת בכתב עברי", "באותיות עבריות כמו שכתוב, בלי תעתיק ובלי תרגום"],
];

function readLangs(): string[] {
  try {
    const raw = sessionStorage.getItem(LANGS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((l): l is string => typeof l === "string" && l in LANGUAGE_LABELS) : [];
  } catch {
    return [];
  }
}

function writeLangs(list: string[]): void {
  try {
    sessionStorage.setItem(LANGS_KEY, JSON.stringify(list));
  } catch {
    // private mode: the choice lasts until reload
  }
}

/** Shown before a volunteer's first line, and on request: what to do, the conventions, and the language choice. */
function onboarding(langs: Set<string>, onStart: () => void): HTMLElement {
  const boxes = Object.entries(LANGUAGE_LABELS).map(([code, label]) => {
    const box = h("input", { type: "checkbox", id: `tl-${code}` }) as HTMLInputElement;
    box.checked = langs.has(code);
    box.addEventListener("change", () => {
      if (box.checked) langs.add(code);
      else langs.delete(code);
    });
    return h("label", { class: "row check", for: `tl-${code}` }, box, ` ${label.he} / ${label.en}`);
  });
  return h(
    "section",
    { class: "card onboard" },
    h("h2", {}, "תעתוק כתבי יד"),
    h(
      "ol",
      {},
      h("li", {}, "בכל פעם מוצגת שורה אחת מכתב יד. מקלידים אותה מאפס, בדיוק כמו שהיא כתובה."),
      h("li", {}, "קטע שאי אפשר לקרוא: הכפתור [?]. כל השורה לא קריאה: \"כל השורה לא קריאה\"."),
      h("li", {}, "המסגרות סומנו במחשב ולפעמים טועות. שורה שמחולקת לכמה מסגרות מקלידים כולה במסגרת הימנית שלה, ובשאר המסגרות בוחרים \"המשך שורה\". מסגרת בלי טקסט, מסגרת על שתי שורות ושורה בלי מסגרת: הכפתורים בשורה \"בעיה במסגרת\"."),
      h("li", {}, "יש ניקוד: מקלידים אותיות בלבד ומסמנים \"יש ניקוד\"."),
      h("li", {}, "כל שורה מתועתקת בנפרד בידי כמה מתנדבים, וההחלטה שלכם סופית. לא רואים כאן תעתיקים של אחרים."),
    ),
    h(
      "p",
      { lang: "en", dir: "ltr", class: "muted small" },
      "One handwritten line at a time: type it from scratch, exactly as written. Use [?] for a part you can't read, or mark the whole line unreadable. The boxes are machine-made: if a line is split over several boxes, type the whole line in its first (rightmost) box and choose \"continued\" on the others. Use the box-problem buttons for a box with no text, a box over two lines, or a line with no box. Several volunteers transcribe each line independently, and your transcription is final.",
    ),
    h("h3", {}, "מקלדת / Keyboard"),
    h("p", { class: "small" }, "העבירו את המקלדת לעברית לפני שמתחילים. בטלפון: מקש הגלובוס או החלפת השפה במקלדת.", h("span", { class: "muted block", lang: "en", dir: "ltr" }, "Switch your keyboard to Hebrew first. On a phone: the globe or language key.")),
    h("h3", {}, "שפות נוספות בכתב עברי / Other languages in Hebrew script"),
    h(
      "p",
      { class: "small muted" },
      "בחלק מהעמודים יש ערבית-יהודית או לדינו בכתב עברי. סמנו רק שפה שאתם קוראים. הבחירה נשמרת בלשונית הזאת בלבד, ולא אצלנו.",
      h("span", { class: "block", lang: "en", dir: "ltr" }, "Some pages are Judeo-Arabic or Ladino in Hebrew script. Tick only a language you read. The choice stays in this browser tab; we don't store it."),
    ),
    ...boxes,
    h("h3", {}, "מוסכמות הקלדה / Typing conventions"),
    h("dl", { class: "small" }, ...[...H_CONVENTIONS, ...LINE_CONVENTIONS].flatMap(([what, type]) => [h("dt", {}, what), h("dd", { dir: "auto" }, type)])),
    h("button", { type: "button", class: "primary", onclick: onStart }, "מתחילים / Start"),
  );
}

/** `startAt` opens one line first (link #p/<id>), if it is open to this reviewer; then the queue continues. */
export function lineTranscribeView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number): ReviewScreen {
  const root = h("div", { class: "review lineverify consensus transcribe" });
  let current: ProposalView | null = null;
  let progress: Progress = batch.progress;
  let busy = false;
  let ready = false;
  let zoom = matchMedia("(max-width: 520px)").matches ? 1 : 2;
  let showPage = false;
  let introDone = false;
  const langs = new Set(readLangs());
  /** Pages this volunteer reported this session (the server keeps one report per volunteer and page anyway). */
  const reported = new Set<string>();
  const fail = failureHandler(root, hooks);
  const view = (): LineTranscribeView | null => (current && current.view.kind === "line_transcribe" ? current.view : null);
  const status = (text: string) => {
    const msg = root.querySelector(".msg");
    if (msg) msg.textContent = text;
  };
  const area = (): HTMLTextAreaElement | null => root.querySelector("textarea.typed");

  async function loadNext(): Promise<void> {
    writeLangs([...langs]);
    const q = langs.size ? `?languages=${[...langs].sort().join(",")}` : "";
    const res = await get<NextResponse>(`/api/batches/${encodeURIComponent(batch.id)}/next${q}`);
    progress = res.progress;
    prefetch(res.prefetch);
    current = res.proposal;
    if (!introDone && progress.decidedByMe === 0) return renderIntro();
    if (!current) return renderDone();
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
      else if (err instanceof ApiFailure && err.code === "invalid_decision") status(err.message);
      else fail(err);
    } finally {
      busy = false;
    }
  }

  /** "A line here has no box": a report on the page; the line in front of the volunteer stays theirs to type. */
  async function reportMissed(): Promise<void> {
    if (!current || busy) return;
    const page = current.itemTitle;
    busy = true;
    try {
      await post(`/api/proposals/${current.id}/page-flag`, { kind: "text_outside_boxes" });
      reported.add(page);
      const b = root.querySelector("button[data-flag]") as HTMLButtonElement | null;
      if (b) b.disabled = true;
      status("תודה, דיווחנו. עכשיו הקלידו את השורה המסומנת. / Reported, thanks. Now type the marked line.");
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "terms_required") await hooks.needTerms();
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

  function save(): void {
    const a = area();
    if (!a) return;
    const text = a.value.replace(/[\r\n]+/g, " ").trim();
    const pointed = (root.querySelector("#tl-pointed") as HTMLInputElement | null)?.checked === true;
    if (text === "") return status("הקלידו את השורה, או בחרו \"כל השורה לא קריאה\". / Type the line, or mark it unreadable.");
    if (pointed && hasNiqqud(text)) return status("עם \"יש ניקוד\" מקלידים אותיות בלבד. / Type letters only.");
    void act(pointed ? "print_has_niqqud" : "edit", text);
  }

  /** Put `s` at the caret (the [?] and dash buttons). */
  function insert(s: string): void {
    const a = area();
    if (!a || a.disabled) return;
    const start = a.selectionStart ?? a.value.length;
    const end = a.selectionEnd ?? start;
    const before = a.value.slice(0, start);
    const pad = s === "[?]" ? [before && !/\s$/.test(before) ? " " : "", " "] : ["", ""];
    a.setRangeText(`${pad[0]}${s}${pad[1]}`, start, end, "end");
    a.focus();
    a.dispatchEvent(new Event("input"));
  }

  function typingBox(p: ProposalView): HTMLElement {
    const a = h("textarea", {
      class: "typed",
      dir: "rtl",
      lang: "he",
      rows: 2,
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      enterkeyhint: "done",
      maxlength: 1000,
      disabled: p.mine !== null,
      "aria-label": "השורה כמו שהיא כתובה / the line as written",
      placeholder: "הקלידו את השורה כמו שהיא כתובה",
    }) as HTMLTextAreaElement;
    const warn = h("p", { class: "warn small", hidden: true, role: "status" }, "יש כאן אותיות לטיניות: האם המקלדת בעברית? / Latin letters: is your keyboard in Hebrew?");
    a.addEventListener("input", () => {
      if (/[\r\n]/.test(a.value)) a.value = a.value.replace(/[\r\n]+/g, " ");
      warn.hidden = !LATIN.test(a.value);
    });
    a.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      } else if (e.key === "Enter") e.preventDefault();
      else if (e.key === "Escape") {
        e.preventDefault();
        a.blur();
      }
    });
    const pointed = h("input", { type: "checkbox", id: "tl-pointed", disabled: p.mine !== null }) as HTMLInputElement;
    return h(
      "div",
      { class: "typebox" },
      a,
      warn,
      h(
        "div",
        { class: "row keys-row" },
        h("button", { type: "button", class: "small", onclick: () => insert("[?]"), title: "A part of the line I can't read", disabled: p.mine !== null }, "[?] קטע לא קריא"),
        h("button", { type: "button", class: "small", onclick: () => insert("–"), title: "Dash", disabled: p.mine !== null }, "–"),
      ),
      h("label", { class: "row check", for: "tl-pointed" }, pointed, " יש ניקוד: הקלדתי אותיות בלבד / Has niqqud: I typed letters only"),
      h("p", { class: "muted small kbdhint" }, "⌨ מקלדת: עברית · Keyboard: Hebrew"),
    );
  }

  function renderStrip(): void {
    const v = view();
    const holder = root.querySelector(".linebox") as HTMLElement | null;
    if (!v || !holder || !v.crop || !v.crop.box) return;
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
    const band = v.crop && v.context ? contextBand(v.crop, v.context, Math.max(200, holder.clientWidth || root.clientWidth || 360), v.boxes) : null;
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

  function render(): void {
    const p = current!;
    const v = view();
    if (!v) throw new Error(`lineTranscribeView cannot show ${p.view.kind}`);
    ready = false;
    showPage = false;
    const option = (value: string) => p.options.find((o) => o.value === value);
    const btn = (value: string, cls: string, onclick: () => void) => {
      const o = option(value);
      return h("button", { type: "button", class: `act ${cls}`, onclick, "data-value": value, title: o?.label.en ?? value, disabled: p.mine !== null }, h("span", {}, o?.label.he ?? value));
    };
    const mine = p.mine ? option(p.mine.value) : undefined;
    const langChip = v.languages.length
      ? h("span", { class: "tag look", title: v.languages.map((l) => l.label.en).join(", ") }, `${v.languages.map((l) => l.label.he).join(", ")} בכתב עברי`)
      : null;
    mount(
      root,
      progressBar(progress),
      h(
        "article",
        { class: "card proposal" },
        h("header", { class: "meta" }, langChip, h("span", { class: "muted small title", dir: "auto" }, p.itemTitle)),
        h(
          "p",
          { class: "ask" },
          "הקלידו את השורה המסומנת בדיוק כמו שהיא כתובה.",
          h("span", { class: "muted small block", lang: "en", dir: "ltr" }, "Type the marked line exactly as written."),
        ),
        h(
          "p",
          { class: "small split" },
          SPLIT_RULE.he,
          h("span", { class: "muted block", lang: "en", dir: "ltr" }, SPLIT_RULE.en),
        ),
        h("div", { class: "linebox" }),
        mine ? h("p", { class: "mine" }, `ההחלטה שלך: ${mine.label.he}`, p.mine?.text ? ` («${p.mine.text}»)` : "", " · החלטה סופית.") : typingBox(p),
        h("p", { class: "msg", role: "status" }),
        h("div", { class: "ctxbox" }),
        h("p", { class: "attrib muted small" }, h("bdi", { class: "block", dir: "auto" }, v.attribution), h("span", { class: "block" }, h("bdi", { dir: "auto" }, v.textLicense))),
      ),
      h(
        "nav",
        { class: "actions four" },
        h("button", { type: "button", class: "act ok", onclick: save, disabled: p.mine !== null, "data-value": "edit" }, h("span", {}, "שמירה / Save"), h("kbd", { dir: "ltr" }, "Ctrl+Enter")),
        btn("unreadable", "bad", () => void act("unreadable")),
        btn("continued", "", () => void act("continued")),
        h("button", { type: "button", class: "act skip", onclick: () => void doSkip(), title: "Skip" }, h("span", {}, "דילוג"), h("kbd", { dir: "ltr" }, "S")),
      ),
      h(
        "div",
        { class: "boxproblems" },
        h("span", { class: "muted small" }, "בעיה במסגרת / Box problem:"),
        btn("no_text", "small", () => void act("no_text")),
        btn("not_on_page", "small", () => void act("not_on_page")),
        h(
          "button",
          { type: "button", class: "act small", "data-flag": "text_outside_boxes", onclick: () => void reportMissed(), disabled: reported.has(p.itemTitle), title: "A text line on this page has no box (a report for the maintainer; then type the marked line)" },
          h("span", {}, "יש כאן שורה בלי מסגרת"),
        ),
      ),
      h(
        "div",
        { class: "subnav" },
        h("button", { type: "button", class: "small", onclick: () => setZoom(-1), "aria-label": "הקטנה / zoom out" }, "−"),
        h("button", { type: "button", class: "small", onclick: () => setZoom(1), "aria-label": "הגדלה / zoom in" }, "+"),
        h("button", { type: "button", class: "small", onclick: renderIntro }, "הסבר, מוסכמות ושפות / Help"),
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
      onboarding(langs, () => {
        introDone = true;
        writeLangs([...langs]);
        void loadNext().catch(fail);
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
        h("button", { type: "button", class: "small", onclick: renderIntro }, "שפות נוספות / Other languages"),
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
    if (!current || current.view.kind !== "line_transcribe" || !root.querySelector(".proposal")) return;
    if (e.repeat) return e.preventDefault();
    const actions: Record<string, () => void> = {
      KeyT: () => area()?.focus(),
      KeyS: () => void doSkip(),
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
