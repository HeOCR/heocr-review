/** A scan crop (or the full page) with the region outlined, and zoom. */
import type { ImageView } from "../../shared/media";
import { h } from "../dom";

const ZOOMS = [1, 1.5, 2, 3, 4];

export interface Viewer {
  el: HTMLElement;
  zoomIn(): void;
  zoomOut(): void;
  togglePage(): void;
}

function figure(img: ImageView, alt: string): HTMLElement {
  const box = img.box;
  return h(
    "div",
    { class: "frame" },
    h("img", { src: img.url, width: img.width, height: img.height, alt, decoding: "async", draggable: "false" }),
    box && !img.outlined
      ? h("div", {
          class: "hl",
          style: `left:${box[0] * 100}%;top:${box[1] * 100}%;width:${(box[2] - box[0]) * 100}%;height:${(box[3] - box[1]) * 100}%`,
        })
      : null,
  );
}

export function viewer(crop: ImageView | null, page: ImageView | null): Viewer {
  let zoom = 0;
  let showPage = !crop && Boolean(page);
  const scroller = h("div", { class: "scroller", tabindex: "0", "aria-label": "סריקה" });
  const level = h("span", { class: "zoomlevel", dir: "ltr" });
  const pageBtn = h("button", { type: "button", class: "small", onclick: () => api.togglePage() }, "");
  const render = () => {
    const img = showPage ? page : crop;
    scroller.replaceChildren(img ? figure(img, showPage ? "העמוד המלא" : "קטע מהסריקה") : h("p", { class: "muted" }, "אין תמונה"));
    const f = scroller.firstElementChild as HTMLElement | null;
    if (f && img) {
      // Fit the image width at zoom 1; never upscale a small crop past 3x of its pixels at zoom 1.
      const fit = showPage ? 100 : Math.min(100, (img.width * 3 * 100) / Math.max(1, scroller.clientWidth || 360));
      f.style.width = `${fit * ZOOMS[zoom]!}%`;
    }
    level.textContent = `${Math.round(ZOOMS[zoom]! * 100)}%`;
    pageBtn.textContent = showPage ? "חזרה לקטע (P)" : "העמוד המלא (P)";
    pageBtn.hidden = !page || !crop;
    if (showPage && img?.box) {
      // Bring the region into view on the full page.
      requestAnimationFrame(() => {
        const hl = scroller.querySelector(".hl") as HTMLElement | null;
        hl?.scrollIntoView({ block: "center", inline: "center" });
      });
    }
  };
  const api: Viewer = {
    el: h(
      "section",
      { class: "viewer" },
      scroller,
      h(
        "div",
        { class: "zoombar" },
        h("button", { type: "button", class: "small", onclick: () => api.zoomOut(), "aria-label": "הקטנה" }, "−"),
        level,
        h("button", { type: "button", class: "small", onclick: () => api.zoomIn(), "aria-label": "הגדלה" }, "+"),
        pageBtn,
      ),
    ),
    zoomIn() {
      zoom = Math.min(ZOOMS.length - 1, zoom + 1);
      render();
    },
    zoomOut() {
      zoom = Math.max(0, zoom - 1);
      render();
    },
    togglePage() {
      if (!page || !crop) return;
      showPage = !showPage;
      zoom = 0;
      render();
    },
  };
  requestAnimationFrame(render);
  render();
  return api;
}
