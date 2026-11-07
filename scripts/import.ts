/**
 * Import a proposals file and its page images into HeOCR Review.
 *
 *   # from hocrgen's bundle (python -m hocrgen.tools.reference_audit --export-dir B --page-images P):
 *   npm run import -- --task reference_audit --bundle <B> [--pages-dir <P>] [--target local|preview|production]
 *   # or from a proposals file and page images (this script cuts the crops):
 *   npm run import -- --task reference_audit --proposals <proposals.json> --pages-dir <P> [--target ...]
 *   options: [--min-reviewers 1] [--dry-run]
 *
 * --pages-dir holds one image per item, named by the item id after its source prefix
 * (wikisource_he_proofread:ws_index_1725257__p0003 -> ws_index_1725257__p0003.jpg), in the page frame the
 * proposal regions were drawn on (any size: regions are fractions of the page). With --bundle it is optional and
 * only adds the full-page view.
 * The script validates the files, puts the crops into public/media/ (gitignored; deploy uploads them as static
 * assets), writes .import/<batch>.sql and applies it to the target D1 database. Restricted sources are refused.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importer } from "../src/tasks/importers";
import type { ProposalMedia } from "../src/tasks/types";
import { parseArgs, str, target } from "./lib/args";
import { assertOpenSource } from "./lib/guard";
import { buildImportSql } from "./lib/importsql";
import { bundleProblems, cutPage, findImage, pageOnly, placeBundleCrop, safeSegment, type BundleCrop, type CropBundle } from "./lib/media";
import { inline } from "./lib/sql";
import { d1File, d1Migrate, d1Query } from "./lib/wrangler";

const ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const taskId = str(flags, "task");
  const bundleDir = typeof flags.bundle === "string" ? flags.bundle : null;
  const proposalsPath = bundleDir ? join(bundleDir, "proposals.json") : str(flags, "proposals");
  const pagesDir = typeof flags["pages-dir"] === "string" ? flags["pages-dir"] : null;
  if (!bundleDir && !pagesDir) throw new Error("give --bundle, or --proposals with --pages-dir");
  const t = target(flags);
  const minReviewers = Number(str(flags, "min-reviewers", "1"));
  if (!Number.isInteger(minReviewers) || minReviewers < 1) throw new Error("--min-reviewers must be a positive integer");
  const task = importer(taskId);
  if (!task) throw new Error(`unknown task type ${taskId}`);
  assertOpenSource(proposalsPath);
  if (bundleDir) assertOpenSource(bundleDir);
  if (pagesDir) assertOpenSource(pagesDir);

  const raw: unknown = JSON.parse(readFileSync(proposalsPath, "utf8"));
  const problems = task.problems(raw);
  if (problems.length) throw new Error(`invalid ${taskId} file:\n  ${problems.slice(0, 20).join("\n  ")}`);
  const bundle = task.bundle(raw);

  const media = new Map<string, ProposalMedia>();
  const missing: string[] = [];
  const byItem = new Map<string, typeof bundle.proposals>();
  for (const p of bundle.proposals) byItem.set(p.itemExternalId, [...(byItem.get(p.itemExternalId) ?? []), p]);
  const publicDir = join(ROOT, "public");
  let bundleCrops: Map<string, BundleCrop> | null = null;
  if (bundleDir) {
    const index = JSON.parse(readFileSync(join(bundleDir, "crops.json"), "utf8")) as CropBundle;
    const bp = bundleProblems(bundleDir, index, bundle.batch.id);
    if (bp.length) throw new Error(`invalid crop bundle:\n  ${bp.slice(0, 20).join("\n  ")}`);
    bundleCrops = new Map(index.crops.map((c) => [c.proposal_id, c]));
  }
  for (const item of bundle.items) {
    const proposals = byItem.get(item.externalId) ?? [];
    const stem = item.imageStem ?? safeSegment(item.externalId);
    const image = pagesDir && item.imageStem ? findImage(pagesDir, item.imageStem) : null;
    if (bundleCrops) {
      const page = image ? await pageOnly(publicDir, bundle.batch.id, stem, image) : null;
      for (const p of proposals) {
        const c = bundleCrops.get(p.externalId);
        if (!c) missing.push(p.externalId);
        else media.set(p.externalId, { crop: placeBundleCrop(publicDir, bundle.batch.id, stem, bundleDir!, c), ...(page ? { page: { ...page, box: p.pageBox } } : {}) });
      }
      continue;
    }
    if (!image) {
      missing.push(item.externalId);
      continue;
    }
    const cut = await cutPage(publicDir, bundle.batch.id, stem, image, proposals.map((p) => ({ externalId: p.externalId, box: p.pageBox })));
    for (const p of proposals) {
      const crop = cut.crops.get(p.externalId);
      media.set(p.externalId, { ...(crop ? { crop } : {}), page: { ...cut.page, box: p.pageBox } });
    }
  }
  if (missing.length) throw new Error(`no crop or page image for ${missing.length} item(s)/proposal(s): ${missing.slice(0, 5).join(", ")}`);

  const sql = buildImportSql(bundle, media, { minReviewers, importedAt: new Date().toISOString() });
  mkdirSync(join(ROOT, ".import"), { recursive: true });
  const sqlPath = join(ROOT, ".import", `${safeSegment(bundle.batch.id)}.sql`);
  writeFileSync(sqlPath, sql);
  const summary = {
    batch: bundle.batch.id,
    task_type: bundle.batch.taskType,
    items: bundle.items.length,
    proposals: bundle.proposals.length,
    crops: [...media.values()].filter((m) => m.crop).length,
    sql: sqlPath,
    target: t,
  };
  if (flags["dry-run"] === true) {
    console.log(JSON.stringify({ ...summary, applied: false }, null, 2));
    return;
  }
  d1Migrate(t);
  const existing = d1Query<{ task_type: string }>(t, inline("SELECT task_type FROM batches WHERE id = ?1", bundle.batch.id))[0] ?? [];
  if (existing[0] && existing[0].task_type !== bundle.batch.taskType) {
    throw new Error(`batch ${bundle.batch.id} already exists with task type ${existing[0].task_type}`);
  }
  d1File(t, sqlPath);
  const counts = d1Query<{ active: number; total: number }>(
    t,
    inline("SELECT SUM(active) AS active, COUNT(*) AS total FROM proposals WHERE batch_id = ?1", bundle.batch.id),
  )[0]?.[0];
  console.log(JSON.stringify({ ...summary, applied: true, active_proposals: counts?.active, stored_proposals: counts?.total }, null, 2));
  if (t !== "local") {
    const cmd = t === "preview" ? "npm run deploy:preview" : "tsx scripts/deploy.ts production --yes-production";
    console.log(`If new crops were added since the last deploy, deploy so they are served: ${cmd}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
