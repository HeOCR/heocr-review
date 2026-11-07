/** Pieces shared by the review views of every task type. */
import type { Progress } from "../../shared/api";
import { ApiFailure } from "../api";
import { h } from "../dom";

export interface ReviewHooks {
  /** The server wants the current terms accepted first; resolve once they are. */
  needTerms(): Promise<void>;
  signedOut(): void;
}

export interface ReviewScreen {
  el: HTMLElement;
  dispose(): void;
}

const prefetched = new Set<string>();
export function prefetch(urls: string[]): void {
  for (const url of urls) {
    if (prefetched.has(url)) continue;
    prefetched.add(url);
    const img = new Image();
    img.decoding = "async";
    img.src = url;
  }
}

export function progressBar(p: Progress): HTMLElement {
  const pct = p.total ? Math.round((p.covered / p.total) * 100) : 0;
  return h(
    "div",
    { class: "progress", role: "status" },
    h("div", { class: "bar", "aria-hidden": "true" }, h("div", { style: `width:${pct}%` })),
    h(
      "span",
      { class: "small" },
      `החלטת על ${p.decidedByMe} · נשארו ${p.remainingForMe}`,
      h("span", { class: "muted" }, ` · נבדקו ${p.covered} מתוך ${p.total} (${pct}%)`),
    ),
  );
}

/** Show an API failure in the view's status line (or sign out on 401). */
export function failureHandler(root: HTMLElement, hooks: ReviewHooks): (err: unknown) => void {
  return (err: unknown) => {
    if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
    const msg = root.querySelector(".msg");
    const text =
      err instanceof ApiFailure && err.code === "rate_limited"
        ? "לאט לאט: יותר מדי פעולות בדקה. נסו שוב עוד רגע. / Too many actions a minute; try again shortly."
        : err instanceof ApiFailure && err.code === "invalid_decision" && err.message
          ? `ההחלטה לא נשמרה: ${err.message}`
          : "שגיאה. נסו שוב. / Error, please try again.";
    if (msg) msg.textContent = text;
    console.warn(err);
  };
}
