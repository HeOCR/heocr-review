import { readFileSync, writeFileSync } from "node:fs";
import { buildImportStatements } from "../../scripts/lib/importsql";
import type { TaskImporter } from "../../src/tasks/import";
import { referenceAuditImporter } from "../../src/tasks/reference_audit/importer";
import { lineVerifyImporter } from "../../src/tasks/line_verify/importer";
import { pageReviewImporter } from "../../src/tasks/page_review/importer";
import type { ProposalMedia } from "../../src/tasks/types";

// Same synthetic bundles and importer as the Worker tests. No project images are imported.
function batch(importer: TaskImporter, path: string, sidecars: Record<string, string> = {}): string[] {
  const read = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
  const bundle = importer.bundle(read(path), Object.fromEntries(Object.entries(sidecars).map(([k, v]) => [k, read(v)])));
  const media = new Map<string, ProposalMedia>(bundle.proposals.map((p) => [p.externalId, {
    crop: { ref: { source: "static", path: "media/fixture/crop.jpg" }, width: 400, height: 120, box: [0.2, 0.3, 0.6, 0.7] },
    page: { ref: { source: "static", path: "media/fixture/page.jpg" }, width: 1000, height: 1400, box: p.pageBox },
  }]));
  return buildImportStatements(bundle, media, { minReviewers: 100, importedAt: "2026-11-07T00:00:00.000Z", after: importer.afterImportSql?.(bundle.batch.id, "2026-11-07T00:00:00.000Z") });
}
const sql = [
  ...batch(referenceAuditImporter, "test/fixtures/proposals.fixture.json"),
  ...batch(lineVerifyImporter, "test/fixtures/line_verify/items.json"),
  ...batch(lineVerifyImporter, "test/fixtures/line_verify_v12/items.json"),
  ...batch(pageReviewImporter, "test/fixtures/page_review/batch_manifest.json", { "blind_prefill.json": "test/fixtures/page_review/blind_prefill.json" }),
];
writeFileSync(process.argv[2]!, sql.map((s) => `${s};`).join("\n"));
