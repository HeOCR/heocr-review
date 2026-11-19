/**
 * Load a batch subset (a filter in the app) from a registered definition file:
 *
 *   npm run import-subset -- --file <interim_v1.json> --batch newprinted_midcentury_v0 [--title "סט ביניים"]
 *     [--target local|production [--yes-production]] [--dry-run]
 *
 * The file's sha256 must be the registered one (scripts/lib/subset.ts), its manifest_sha256 the batch's, and every
 * member an active, ungated proposal of the batch. Only the subset tables change (migrations/0003_subsets.sql); the
 * app serves the subset at #b/<batch>/s/<id>, where <id> is the file name without .json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, str, target } from "./lib/args";
import { assertOpenSource } from "./lib/guard";
import { sha256File } from "./lib/media";
import { inline } from "./lib/sql";
import { REGISTERED_SHA256, buildSubsetStatements, interimMembers, interimProblems } from "./lib/subset";
import { d1File, d1Migrate, d1Query } from "./lib/wrangler";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const file = str(flags, "file");
  const batchId = str(flags, "batch");
  const title = str(flags, "title", "סט ביניים");
  const t = target(flags);
  assertOpenSource(file);
  const name = basename(file);
  const sha = sha256File(file);
  if (REGISTERED_SHA256[name] !== sha) throw new Error(`${name}: sha256 ${sha} is not the registered one (${REGISTERED_SHA256[name] ?? "none registered"})`);
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const problems = interimProblems(raw);
  if (problems.length) throw new Error(`invalid ${name}:\n  ${problems.slice(0, 20).join("\n  ")}`);
  const members = interimMembers(raw);
  const id = name.replace(/\.json$/, "");

  // The target's batch must be the one the file was drawn from, with every member an active, ungated proposal.
  const batch = d1Query<{ source_json: string }>(t, inline("SELECT source_json FROM batches WHERE id = ?1", batchId))[0]?.[0];
  if (!batch) throw new Error(`no batch ${batchId} on ${t}`);
  const manifest = (JSON.parse(batch.source_json) as { manifest_sha256?: string }).manifest_sha256;
  const wanted = (raw as { manifest_sha256: string }).manifest_sha256;
  if (manifest !== wanted) throw new Error(`${name} was drawn from manifest ${wanted}; batch ${batchId} on ${t} is ${manifest}`);
  const rows = d1Query<{ external_id: string; active: number; gate_kind: string | null }>(
    t,
    inline("SELECT external_id, active, gate_kind FROM proposals WHERE batch_id = ?1", batchId),
  )[0] ?? [];
  const byId = new Map(rows.map((r) => [r.external_id, r]));
  const bad = members.filter((m) => {
    const r = byId.get(m.externalId);
    return !r || r.active !== 1 || r.gate_kind !== null;
  });
  if (bad.length) throw new Error(`not an active, ungated proposal of ${batchId}: ${bad.slice(0, 10).map((m) => m.externalId).join(", ")}`);

  const sql = buildSubsetStatements(batchId, { id, title, sourceSha256: sha }, members, new Date().toISOString()).join("\n") + "\n";
  mkdirSync(join(ROOT, ".import"), { recursive: true });
  const sqlPath = join(ROOT, ".import", `subset_${batchId}_${id}.sql`);
  writeFileSync(sqlPath, sql);
  const strata = new Set(members.map((m) => m.stratum)).size;
  const summary = { batch: batchId, subset: id, title, sha256: sha, strata, members: members.length, sql: sqlPath, target: t };
  if (flags["dry-run"] === true) {
    console.log(JSON.stringify({ ...summary, applied: false }, null, 2));
    return;
  }
  d1Migrate(t);
  d1File(t, sqlPath);
  const n = d1Query<{ n: number }>(t, inline("SELECT COUNT(*) AS n FROM subset_members WHERE batch_id = ?1 AND subset_id = ?2", batchId, id))[0]?.[0]?.n;
  console.log(JSON.stringify({ ...summary, applied: true, stored_members: n, app: `#b/${batchId}/s/${id}` }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
