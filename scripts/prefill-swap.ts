/**
 * Put a ratified pre-fill bundle's drafts into a live line_verify batch (heocr-eval's test pre-fill protocol,
 * amendment 1):
 *
 *   npm run prefill-swap -- --batch <id> --bundle <items.json> --sha256 <ratified sha> [--target local|production
 *     [--yes-production]] [--dry-run]
 *
 * Refuses unless items.json's sha256 is the ratified one and the bundle is the live batch apart from the drafts
 * (scripts/lib/prefill.ts). Writes a draft only into a pass-1 typed line with no decision; the UPDATE itself checks
 * again, so a line answered during the swap keeps no draft. Decisions are never touched. Before writing, it saves an
 * undo file (old payload and content hash per line) to .import/prefill-undo/, and it prints the counts heocr-eval
 * asked for: written, skipped as already decided, rejected by the typed-line rule (with item ids), without a draft.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, str, target } from "./lib/args";
import { checkWriteBudget } from "./lib/d1budget";
import { sha256File } from "./lib/media";
import { planPrefillSwap, type LiveProposal } from "./lib/prefill";
import { inline, lit } from "./lib/sql";
import { d1File, d1Query } from "./lib/wrangler";

const ROOT = resolve(import.meta.dirname, "..");

export const LIVE_SQL = `SELECT p.id, p.external_id, p.payload_json, p.content_sha256,
  (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id) AS decisions
  FROM proposals p WHERE p.batch_id = ?1`;

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const t = target(flags);
  const batchId = str(flags, "batch");
  const bundlePath = resolve(str(flags, "bundle"));
  const want = str(flags, "sha256");
  const got = sha256File(bundlePath);
  if (got !== want) throw new Error(`${bundlePath}: sha256 ${got} is not the ratified ${want}`);

  const live = d1Query<LiveProposal>(t, inline(LIVE_SQL, batchId))[0] ?? [];
  if (!live.length) throw new Error(`batch ${batchId} has no proposals on ${t}`);
  const plan = planPrefillSwap(JSON.parse(readFileSync(bundlePath, "utf8")), batchId, live);
  const counts = {
    batch: batchId,
    bundle_sha256: got,
    target: t,
    written: plan.updates.length,
    skipped_decided: plan.skipped_decided.length,
    already_drafted: plan.already,
    rejected: plan.rejected.length,
    no_draft: plan.no_draft,
    provenances: plan.provenances,
  };
  if (flags["dry-run"] === true) {
    console.log(JSON.stringify({ ...counts, rejected_items: plan.rejected, applied: false }, null, 2));
    return;
  }
  // One UPDATE per line, plus its index entry and the batch's record: counted like an import.
  await checkWriteBudget(t, plan.updates.length * 3 + 2, flags);

  const stamp = new Date().toISOString();
  const dir = join(ROOT, ".import", "prefill-undo");
  mkdirSync(dir, { recursive: true });
  const undoPath = join(dir, `${batchId}-${stamp.replace(/[:.]/g, "")}.json`);
  writeFileSync(
    undoPath,
    JSON.stringify({ batch_id: batchId, bundle_sha256: got, made_at: stamp, target: t, lines: plan.updates.map((u) => ({ id: u.id, item_id: u.item_id, payload_json: u.old_payload_json, content_sha256: u.old_content_sha256 })) }, null, 1) + "\n",
  );

  const record = { bundle_sha256: got, at: stamp, written: plan.updates.length, provenances: plan.provenances };
  const sql = [
    ...plan.updates.map(
      (u) =>
        `UPDATE proposals SET payload_json = ${lit(u.payload_json)}, content_sha256 = ${lit(u.content_sha256)} WHERE id = ${u.id} AND content_sha256 = ${lit(u.old_content_sha256)} AND NOT EXISTS (SELECT 1 FROM decisions WHERE proposal_id = ${u.id});`,
    ),
    // The batch keeps a list of its swaps, so an export can be traced to the bundle that drafted it.
    `UPDATE batches SET source_json = json_set(source_json, '$.prefill', json_insert(COALESCE(json_extract(source_json, '$.prefill'), json('[]')), '$[#]', json(${lit(JSON.stringify(record))}))) WHERE id = ${lit(batchId)};`,
  ].join("\n");
  const sqlPath = join(dir, `${batchId}-${stamp.replace(/[:.]/g, "")}.sql`);
  writeFileSync(sqlPath, sql + "\n");
  d1File(t, sqlPath);

  // Read back: how many of the planned lines now hold their draft.
  const after = d1Query<LiveProposal>(t, inline(LIVE_SQL, batchId))[0] ?? [];
  const byId = new Map(after.map((r) => [r.id, r]));
  const landed = plan.updates.filter((u) => byId.get(u.id)?.content_sha256 === u.content_sha256).length;
  console.log(JSON.stringify({ ...counts, written: landed, answered_during_swap: plan.updates.length - landed, rejected_items: plan.rejected, undo: undoPath, applied: true }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
