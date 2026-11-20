import { get, put } from "../api";
import { h } from "../dom";

interface AdminBatch {
  id: string;
  taskType: string;
  title: string;
  status: string;
  minReviewers: number;
  counts: Record<string, number>;
  reviewers: { id: string; decisions: number }[];
}

function download(name: string, content: unknown): void {
  const blob = new Blob([JSON.stringify(content, null, 1) + "\n"], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

interface VolunteerRow {
  id: string;
  lines: number;
  goldSeen: number;
  goldHits: number;
  accuracy: number | null;
  plantedSeen: number;
  plantedHits: number;
  standing: string;
  excludedAt: string | null;
}

interface VolunteerReport {
  states: Record<string, number>;
  volunteers: VolunteerRow[];
}

/**
 * A volunteer batch (line_consensus): line states, and per volunteer their gold record and standing, with the
 * switch that excludes a volunteer from agreement. Admins only; never shown to volunteers.
 */
function volunteerPanel(batchId: string): HTMLElement {
  const box = h("div", { class: "volunteers" }, h("p", { class: "small muted" }, "Loading volunteers…"));
  const path = `/api/admin/batches/${encodeURIComponent(batchId)}`;
  const draw = (r: VolunteerReport) => {
    const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 1000) / 10}%`);
    box.replaceChildren(
      h("p", { class: "small" }, "Line states: ", Object.entries(r.states).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"),
      h(
        "table",
        { class: "small" },
        h("thead", {}, h("tr", {}, ...["Reviewer", "Lines", "Gold", "Accuracy", "Planted", "Standing", ""].map((t) => h("th", {}, t)))),
        h(
          "tbody",
          {},
          ...r.volunteers.map((v) =>
            h(
              "tr",
              {},
              h("td", { class: "mono" }, v.id),
              h("td", { class: "mono" }, String(v.lines)),
              h("td", { class: "mono" }, `${v.goldHits}/${v.goldSeen}`),
              h("td", { class: "mono" }, pct(v.accuracy)),
              h("td", { class: "mono" }, `${v.plantedHits}/${v.plantedSeen}`),
              h("td", {}, v.standing),
              h(
                "td",
                {},
                h(
                  "button",
                  {
                    type: "button",
                    class: "small",
                    onclick: () => void put<VolunteerReport>(`${path}/reviewers/${v.id}/exclusion`, { excluded: v.excludedAt === null }).then(draw, () => undefined),
                  },
                  v.excludedAt === null ? "Exclude from agreement" : "Include again",
                ),
              ),
            ),
          ),
        ),
      ),
    );
  };
  get<VolunteerReport>(`${path}/volunteers`).then(draw, () => box.replaceChildren(h("p", { class: "small muted" }, "Volunteer review is off here.")));
  return box;
}

interface FlaggedPage {
  itemId: number;
  pageKey: string;
  kind: string;
  reports: number;
  firstReportedAt: string;
  answer: "confirmed" | "dismissed" | null;
  page: { url: string; width: number; height: number } | null;
  boxes: [number, number, number, number][];
}

/**
 * Handwriting transcription: pages volunteers reported as having a text line no box covers, with the boxes drawn
 * on the page. The maintainer confirms (the page goes back for re-boxing) or dismisses.
 */
function flaggedPanel(batchId: string): HTMLElement {
  const box = h("div", { class: "flagged" }, h("p", { class: "small muted" }, "Loading reported pages…"));
  const path = `/api/admin/batches/${encodeURIComponent(batchId)}`;
  const draw = ({ pages }: { pages: FlaggedPage[] }) => {
    if (!pages.length) return box.replaceChildren(h("p", { class: "small muted" }, "No page reported as having text outside the boxes."));
    box.replaceChildren(
      h("h4", {}, `Text outside the boxes: ${pages.filter((p) => p.answer === null).length} waiting`),
      ...pages.map((p) => {
        const answer = (a: "confirmed" | "dismissed" | null) => void put<{ pages: FlaggedPage[] }>(`${path}/items/${p.itemId}/page-flag`, { kind: p.kind, answer: a }).then(draw, () => undefined);
        const fig = p.page
          ? h(
              "figure",
              {},
              h("img", { src: p.page.url, alt: p.pageKey, loading: "lazy" }),
              ...p.boxes.map(([x0, y0, x1, y1]) => h("span", { class: "fbox", style: `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%` })),
            )
          : null;
        return h(
          "div",
          { class: "card" },
          h("p", { class: "small" }, h("span", { class: "mono" }, p.pageKey), ` · ${p.reports} report(s) since ${p.firstReportedAt.slice(0, 16)} · `, p.answer ?? "waiting"),
          fig,
          h(
            "div",
            { class: "row" },
            h("button", { type: "button", class: "small", onclick: () => answer("confirmed"), disabled: p.answer === "confirmed" }, "Confirm: re-box this page"),
            h("button", { type: "button", class: "small", onclick: () => answer("dismissed"), disabled: p.answer === "dismissed" }, "Dismiss: every line has a box"),
            p.answer ? h("button", { type: "button", class: "small", onclick: () => answer(null) }, "Undo") : null,
          ),
        );
      }),
    );
  };
  get<{ pages: FlaggedPage[] }>(`${path}/page-flags`).then(draw, () => box.replaceChildren(h("p", { class: "small muted" }, "Volunteer review is off here.")));
  return box;
}

export function adminView(): HTMLElement {
  const root = h("section", { class: "card", dir: "ltr", lang: "en" }, h("p", {}, "Loading…"));
  get<{ batches: AdminBatch[] }>("/api/admin/progress")
    .then(({ batches }) => {
      root.replaceChildren(
        h("h2", {}, "Progress (admin)"),
        ...batches.map((b) => {
          const msg = h("p", { class: "msg" });
          return h(
            "div",
            { class: "adminbatch" },
            h("h3", {}, `${b.title} `, h("span", { class: "muted small mono" }, `${b.id} · ${b.taskType} · ${b.status} · min ${b.minReviewers}`)),
            h(
              "table",
              {},
              h("tbody", {}, ...Object.entries(b.counts).map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", { class: "mono" }, String(v))))),
            ),
            b.taskType === "line_consensus" || b.taskType === "line_transcribe"
              ? volunteerPanel(b.id)
              : h("p", { class: "small" }, "Reviewers: ", b.reviewers.map((r) => `${r.id} (${r.decisions})`).join(", ") || "none"),
            b.taskType === "line_transcribe" ? flaggedPanel(b.id) : null,
            h(
              "button",
              {
                type: "button",
                class: "primary",
                onclick: () =>
                  void get<{ files: Record<string, unknown>; problems: string[] }>(`/api/admin/batches/${encodeURIComponent(b.id)}/export`).then(
                    (res) => {
                      for (const [name, content] of Object.entries(res.files)) download(name, content);
                      msg.textContent = res.problems.length ? `Validation problems: ${res.problems.slice(0, 5).join("; ")}` : "Exported; validation passed.";
                    },
                    () => (msg.textContent = "Export failed"),
                  ),
              },
              "Export decisions + ledger",
            ),
            msg,
          );
        }),
      );
    })
    .catch(() => root.replaceChildren(h("p", {}, "Admin only.")));
  return root;
}
