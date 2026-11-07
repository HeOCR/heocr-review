import { get } from "../api";
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
            h("p", { class: "small" }, "Reviewers: ", b.reviewers.map((r) => `${r.id} (${r.decisions})`).join(", ") || "none"),
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
