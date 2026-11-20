import { OUTSIDE_PAGE_PASTE } from "../src/tasks/line_verify/page_paste";
/**
 * Import heocr-eval's ratified plant list into a triage batch (reference_triage_v1 amendment 2):
 *
 *   npm run import-plants -- --batch <id> --plants <plants.json> --sha256 <ratified sha> [--target local|production
 *     [--yes-production]] [--dry-run]
 *
 * Run it after the batch's drafts are swapped in (scripts/prefill-swap.ts): a plant names the candidate it was made on.
 * Refuses a wrong sha256, a batch not in triage mode, and any plant that does not match its line (all or nothing).
 * Lines already answered get no plant. Replaces the batch's earlier plants for the lines it names.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROPOSAL_COLUMNS, toProposal, type ProposalRow } from "../src/tasks/rows";
import { parseArgs, str, target } from "./lib/args";
import { checkWriteBudget } from "./lib/d1budget";
import { sha256File } from "./lib/media";
import { planPlants } from "./lib/plants";
import { inline, lit } from "./lib/sql";
import { d1Query } from "./lib/wrangler";

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const t = target(flags);
  const batchId = str(flags, "batch");
  const path = resolve(str(flags, "plants"));
  const want = str(flags, "sha256");
  const got = sha256File(path);
  if (got !== want) throw new Error(`${path}: sha256 ${got} is not the ratified ${want}`);
  const mode = d1Query<{ mode: string | null }>(t, inline("SELECT (SELECT s.mode FROM batch_settings s WHERE s.batch_id = b.id) AS mode FROM batches b WHERE b.id = ?1", batchId))[0]?.[0];
  if (!mode) throw new Error(`no batch ${batchId} on ${t}`);
  if (mode.mode !== "triage") throw new Error(`batch ${batchId} is not in triage mode: set it first (batch-setting --mode triage)`);
  const rows = d1Query<ProposalRow & { decisions: number }>(
    t,
    inline(
      `SELECT ${PROPOSAL_COLUMNS}, (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id) AS decisions
       FROM proposals p JOIN items i ON i.id = p.item_id WHERE p.batch_id = ?1 AND p.active = 1 AND ${OUTSIDE_PAGE_PASTE}`,
      batchId,
    ),
  )[0]!;
  const plan = planPlants(JSON.parse(readFileSync(path, "utf8")), rows.map((r) => ({ proposal: toProposal(r), decisions: r.decisions })));
  const counts = { batch: batchId, plants_sha256: got, target: t, planted: plan.rows.length, skipped_decided: plan.skipped_decided.length, refused: plan.refused.length };
  if (plan.refused.length) throw new Error(`refused (nothing written): ${JSON.stringify({ ...counts, refused_items: plan.refused.slice(0, 20) })}`);
  if (flags["dry-run"] === true) return void console.log(JSON.stringify({ ...counts, applied: false }, null, 2));
  await checkWriteBudget(t, plan.rows.length * 3 + 2, flags);
  const now = new Date().toISOString();
  const values = plan.rows.map(
    (r) => `(${lit(batchId)}, ${r.proposal_id}, ${lit(r.item_id)}, ${lit(r.plant_type)}, ${lit(r.position)}, ${lit(r.planted_text)}, ${lit(r.planted_sha256)}, ${lit(r.candidate_sha256)}, ${lit(got)}, ${lit(now)})`,
  );
  for (let i = 0; i < values.length; i += 50) {
    d1Query(
      t,
      `INSERT INTO triage_plants (batch_id, proposal_id, item_id, plant_type, position, planted_text, planted_sha256, candidate_sha256, plants_sha256, imported_at) VALUES ${values.slice(i, i + 50).join(", ")}
       ON CONFLICT (batch_id, proposal_id) DO UPDATE SET plant_type = excluded.plant_type, position = excluded.position, planted_text = excluded.planted_text,
         planted_sha256 = excluded.planted_sha256, candidate_sha256 = excluded.candidate_sha256, plants_sha256 = excluded.plants_sha256, imported_at = excluded.imported_at`,
    );
  }
  const [stored] = d1Query<{ n: number }>(t, inline("SELECT COUNT(*) AS n FROM triage_plants WHERE batch_id = ?1 AND plants_sha256 = ?2", batchId, got))[0]!;
  console.log(JSON.stringify({ ...counts, stored: stored!.n, applied: true }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
