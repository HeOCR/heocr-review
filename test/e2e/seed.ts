import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { buildImportStatements } from "../../scripts/lib/importsql";
import { lit } from "../../scripts/lib/sql";
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
for (const [arm, background] of [["red", "#e01010"], ["blue", "#1010e0"]] as const) {
  const jpeg = await sharp({ create: { width: 30, height: 42, channels: 3, background } }).jpeg().toBuffer();
  sql.push(`INSERT INTO synth_realism_assets (sha256,part,base64) VALUES (${lit(arm)},0,${lit(jpeg.toString("base64"))})`);
}
for (const ranking of ["fixture-realism-ranking", "fixture-realism-ranking-mirror"]) {
  sql.push(`INSERT INTO batches (id,task_type,title,source_json,status,imported_at)
    VALUES (${lit(ranking)},'synth_realism','Ranking fixture','{"realism_mode":"ranking","fixture":true}','open','2026-11-21')`);
  for (let position = 1; position <= 5; position++) {
    sql.push(`INSERT INTO synth_ranking_pairs (batch_id,position,pair_id,item_a,arm_a,image_a,item_b,arm_b,image_b)
      VALUES (${[ranking, position, "pair-" + position, "red-" + position, "red", "red",
        "blue-" + position, "blue", "blue"].map(lit).join(",")})`);
  }
}
writeFileSync(process.argv[2]!, sql.map((s) => `${s};`).join("\n"));
