import { SYNTH_REALISM } from "../../shared/synth_realism";
import { t } from "../i18n";
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
            b.taskType === "line_consensus"
              ? volunteerPanel(b.id)
              : h("p", { class: "small" }, "Reviewers: ", b.reviewers.map((r) => `${r.id} (${r.decisions})`).join(", ") || "none"),
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
              b.taskType === SYNTH_REALISM ? t("sr_export") : "Export decisions + ledger",
            ),
            msg,
          );
        }),
      );
    })
    .catch(() => root.replaceChildren(h("p", {}, "Admin only.")));
  return root;
}
