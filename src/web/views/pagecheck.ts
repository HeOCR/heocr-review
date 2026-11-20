/**
 * Page completeness screens (migrations/0014_page_completeness.sql; heocr-eval's reference_triage_v1 amendment 1).
 *
 * "check" (triage, any screen): the page with every line box drawn, and one question: is every printed line boxed?
 * Yes (1, Enter) or no (2); no sends the page to the desktop. "add" (the desktop queue): the same page, where the
 * reviewer drags a box around each missing line and types it (or marks it unreadable), then says they are done.
 */
import type { PageCheckView } from "../../shared/api";
import type { Box } from "../../shared/media";
import { h } from "../dom";
import { t } from "../i18n";
import { icon } from "../icons";

export interface PageScreenHooks {
  answer(value: "complete" | "missing_lines"): Promise<void>;
  add(box: Box, value: "typed" | "unreadable", text: string | null): Promise<string | null>;
  remove(id: string): Promise<void>;
  done(): Promise<void>;
}

const pct = (b: Box) => `left:${b[0] * 100}%;top:${b[1] * 100}%;width:${(b[2] - b[0]) * 100}%;height:${(b[3] - b[1]) * 100}%`;

/** The screen, and a dispose that removes its keys. */
export function pageScreen(v: PageCheckView, hooks: PageScreenHooks): { el: HTMLElement; dispose: () => void } {
  let busy = false;
  const run = (fn: () => Promise<unknown>) => async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };
  const frame = h(
    "div",
    { class: "frame pageframe" },
    v.image ? h("img", { src: v.image.url, width: v.image.width, height: v.image.height, alt: `${t("pg")} · ${v.title}`, decoding: "async", draggable: "false" }) : h("p", { class: "muted" }, t("no_image")),
    ...v.boxes.map((b) => h("div", { class: "pb", style: pct(b.box) })),
    ...v.added.map((a, k) => h("div", { class: "pb added", style: pct(a.box) }, h("span", {}, String(k + 1)))),
  );

  if (v.mode === "check") {
    const yes = run(() => hooks.answer("complete"));
    const no = run(() => hooks.answer("missing_lines"));
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "BUTTON" || target.tagName === "A") && (e.key === "Enter" || e.key === " ")) return;
      const fn = ({ Enter: yes, NumpadEnter: yes, Digit1: yes, Digit2: no } as Record<string, () => void>)[e.code];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    document.addEventListener("keydown", onKey);
    const el = h(
      "div",
      { class: "review lineverify triage pagecheck" },
      h("p", { class: "ask" }, t("pc_ask")),
      h("p", { class: "muted small" }, h("bdi", {}, v.title), ` · ${t("pc_boxes", { n: v.boxes.length })}`),
      h("div", { class: "pagewrap" }, frame),
      h(
        "footer",
        { class: "dock" },
        h(
          "nav",
          { class: "actions" },
          h("button", { type: "button", class: "act primary tri", onclick: yes }, h("span", {}, t("pc_yes")), h("kbd", {}, "1")),
          h("button", { type: "button", class: "act tri", onclick: no }, h("span", {}, t("pc_no")), h("kbd", {}, "2")),
        ),
      ),
    );
    return { el, dispose: () => document.removeEventListener("keydown", onKey) };
  }

  // ---------- add (desktop): drag a box, type the line ----------
  const form = h("div", { class: "addform", hidden: true });
  let drawn: Box | null = null;
  let temp: HTMLElement | null = null;
  let start: [number, number] | null = null;
  const at = (e: PointerEvent): [number, number] => {
    const r = frame.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const boxOf = (a: [number, number], b: [number, number]): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  frame.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !form.hidden) return;
    e.preventDefault();
    frame.setPointerCapture(e.pointerId);
    start = at(e);
    temp?.remove();
    temp = h("div", { class: "pb drawing" });
    frame.append(temp);
  });
  frame.addEventListener("pointermove", (e) => {
    if (!start || !temp) return;
    temp.setAttribute("style", pct(boxOf(start, at(e))));
  });
  frame.addEventListener("pointerup", (e) => {
    if (!start) return;
    const b = boxOf(start, at(e));
    start = null;
    if (b[2] - b[0] < 0.01 || b[3] - b[1] < 0.005) {
      temp?.remove();
      temp = null;
      return;
    }
    drawn = b;
    openForm();
  });

  function openForm(): void {
    const area = h("textarea", { dir: "rtl", lang: "he", rows: 2, spellcheck: "false", maxlength: 1000, "aria-label": t("pa_type"), placeholder: t("type_ph") }) as HTMLTextAreaElement;
    const msg = h("p", { class: "msg", role: "status" });
    const close = () => {
      form.hidden = true;
      form.replaceChildren();
      temp?.remove();
      temp = null;
      drawn = null;
    };
    const save = run(async () => {
      if (!drawn) return;
      const text = area.value.replace(/[\r\n]+/g, " ").trim();
      if (!text) return void msg.replaceChildren(t("type_line"));
      const id = await hooks.add(drawn, "typed", text);
      if (id === null) return void msg.replaceChildren(t("type_letters"));
      close();
    });
    const unreadable = run(async () => {
      if (!drawn) return;
      await hooks.add(drawn, "unreadable", null);
      close();
    });
    area.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    form.replaceChildren(
      h("p", { class: "muted small" }, t("pa_type")),
      area,
      msg,
      h(
        "div",
        { class: "savebar" },
        h("button", { type: "button", class: "act primary", onclick: save }, t("pa_save"), " ", h("kbd", {}, "Enter")),
        h("button", { type: "button", class: "act", onclick: unreadable }, t("unread")),
        h("button", { type: "button", class: "act quiet", onclick: close }, t("cancel"), " ", h("kbd", {}, "Esc")),
      ),
    );
    form.hidden = false;
    area.focus();
  }

  const list = h(
    "ol",
    { class: "addedlist" },
    ...v.added.map((a) =>
      h(
        "li",
        {},
        h("bdi", { dir: "rtl" }, a.value === "unreadable" ? t("unread") : (a.text ?? "")),
        " ",
        h("button", { type: "button", class: "act quiet", onclick: run(() => hooks.remove(a.id)) }, icon("close", { sm: true }), t("pa_remove")),
      ),
    ),
  );
  const el = h(
    "div",
    { class: "review lineverify pageadd" },
    h("p", { class: "ask" }, t("pa_title")),
    h("p", { class: "muted small" }, h("bdi", {}, v.title), ` · ${t("pa_hint")}`),
    h("div", { class: "pagewrap" }, frame),
    form,
    h("h2", { class: "small" }, t("pa_added", { n: v.added.length })),
    list,
    h("div", { class: "savebar" }, h("button", { type: "button", class: "act primary", onclick: run(() => hooks.done()) }, t("pa_done"))),
  );
  return { el, dispose: () => {} };
}
