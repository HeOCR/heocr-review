/**
 * Add eval's registered P-hist gold (docs/specs/line_verify_phist_gold_v1_1.md) to a volunteer_v1_1 line_verify batch:
 *
 *   npm run import-gold -- --batch <id> --gold <dir with phist_gold_v1_1_1.json and its page images> [--target local|preview|production] [--dry-run]
 *
 * The file's sha256 must be the registered one, and each page image must match its record. The gold lines are
 * upserted as proposals of the batch (crops into public/media/, gitignored), with nothing else in the batch changed:
 * no line deactivated, no setting touched. Idempotent. Writes .import/<batch>.gold.sql and applies it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PHIST_GOLD_FILE, PHIST_GOLD_SHA256, PHIST_GOLD_SUPERSEDED, goldFileProblems, goldImport, type GoldFile } from "../src/tasks/line_verify/gold";
import type { ProposalMedia } from "../src/tasks/types";
import { parseArgs, str, target } from "./lib/args";
import { buildImportStatements } from "./lib/importsql";
import { bundleImageProblems, cutLines, safeSegment, sha256File } from "./lib/media";
import { inline } from "./lib/sql";
import { d1File, d1Migrate, d1Query } from "./lib/wrangler";

const ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const batchId = str(flags, "batch");
  const dir = str(flags, "gold");
  const t = target(flags);
  for (const old of PHIST_GOLD_SUPERSEDED) if (existsSync(join(dir, old))) throw new Error(`${old} is superseded by ${PHIST_GOLD_FILE}: the directory must hold ${PHIST_GOLD_FILE} only`);
  const path = join(dir, PHIST_GOLD_FILE);
  const sha = sha256File(path);
  if (sha !== PHIST_GOLD_SHA256) throw new Error(`${PHIST_GOLD_FILE}: sha256 ${sha} is not the registered one (${PHIST_GOLD_SHA256})`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const problems = goldFileProblems(raw);
  if (problems.length) throw new Error(`invalid ${PHIST_GOLD_FILE}:\n  ${problems.slice(0, 20).join("\n  ")}`);
  const file = raw as GoldFile;

  d1Migrate(t);
  const row = d1Query<{ task_type: string; resolution: string | null }>(
    t,
    inline("SELECT b.task_type, (SELECT s.resolution FROM batch_settings s WHERE s.batch_id = b.id) AS resolution FROM batches b WHERE b.id = ?1", batchId),
  )[0]?.[0];
  if (!row) throw new Error(`no batch ${batchId} in ${t}`);
  if (row.task_type !== "line_verify" || row.resolution !== "volunteer_v1_1") {
    throw new Error(`${batchId} is ${row.task_type} with resolution ${row.resolution ?? "single"}: gold goes only into a line_verify batch set to volunteer_v1_1`);
  }

  const { items, proposals } = goldImport(file);
  const bp = bundleImageProblems(dir, items.map((i) => i.bundleImage!));
  if (bp.length) throw new Error(`invalid gold images:\n  ${bp.slice(0, 20).join("\n  ")}`);
  const publicDir = join(ROOT, "public");
  const media = new Map<string, ProposalMedia>();
  for (const item of items) {
    const mine = proposals.filter((p) => p.itemExternalId === item.externalId);
    const { width, height } = item.bundleImage!;
    const cut = await cutLines(publicDir, batchId, safeSegment(item.externalId), join(dir, item.bundleImage!.path), { width: width!, height: height! },
      mine.map((p) => ({ externalId: p.externalId, box: p.pageBox!, contextBox: p.contextBox! })));
    for (const p of mine) media.set(p.externalId, { crop: cut.crops.get(p.externalId)!, page: { ...cut.page, box: p.pageBox } });
  }
  const statements = buildImportStatements(
    { batch: { id: batchId, taskType: "line_verify", title: "", source: {} }, items, proposals },
    media,
    { minReviewers: 1, importedAt: new Date().toISOString(), addOnly: true },
  );
  mkdirSync(join(ROOT, ".import"), { recursive: true });
  const sqlPath = join(ROOT, ".import", `${safeSegment(batchId)}.gold.sql`);
  writeFileSync(sqlPath, statements.join("\n") + "\n");
  const summary = { batch: batchId, gold_file: PHIST_GOLD_FILE, sha256: sha, pages: items.length, gold_lines: proposals.length, sql: sqlPath, target: t };
  if (flags["dry-run"] === true) {
    console.log(JSON.stringify({ ...summary, applied: false }, null, 2));
    return;
  }
  d1File(t, sqlPath);
  const after = d1Query<{ gold: number }>(t, inline("SELECT COUNT(*) AS gold FROM proposals WHERE batch_id = ?1 AND active = 1 AND json_extract(payload_json, '$.gold') IS NOT NULL", batchId))[0]?.[0];
  console.log(JSON.stringify({ ...summary, applied: true, active_gold: after?.gold }, null, 2));
  console.log(`Deploy so the gold crops are served: ${t === "preview" ? "npm run deploy:preview" : t === "production" ? "tsx scripts/deploy.ts production --yes-production" : "(local)"}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
