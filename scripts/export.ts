/**
 * Export a batch's decisions from D1 in the consumer's format, plus the full ledger.
 *
 *   npm run export -- --batch e2d4_reference_audit_v1 [--target local|production] [--out out/] [--public]
 *
 * Writes the task type's decisions file (reference_audit_decisions.json: exactly hocrgen's
 * reference_audit_decisions.v1; line_verify_decisions.json: line_verify_decisions.v1.1, or v1.2 for a v1.1 batch, with
 * each decision's pass), one decision per reviewer per proposal, and <name>_ledger.json (every decision of every reviewer, reviewer counts, conflicts, and opted-in
 * credits). Validates the decisions file before writing; prints counts only.
 * With --public it writes only the public view instead (<name>.public.json and <name>_ledger.public.json, see
 * src/tasks/public_export.ts): no per-pseudonym accuracy, standing or counted status, and no gold-line decisions.
 * Anything that goes to a public repository or release is the public view, and passes `npm run check-public`.
 * Then copy the decisions file over hocrgen's docs/reference_audit_decisions.json in a PR, and check it there:
 *   python -m hocrgen.tools.reference_audit --decisions docs/reference_audit_decisions.json
 */
import { SYNTH_REALISM } from "../src/shared/synth_realism";
import { EXPORT_FILE, REALISM_EXPORT_SQL, realismExport, type RealismRow } from "../src/tasks/synth_realism/export";
import { TRIAGE_PLANTS_SQL, toTriagePlant, type TriagePlantRow } from "../src/tasks/line_verify/triage";
import { ADDED_LINES_SQL, PAGE_CHECKS_SQL, TRIAGE_PAGES_SQL, toTriagePages, type AddedLineRow, type PageCheckRow, type TriagePageRow } from "../src/tasks/line_verify/pagerecords";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExport, formatJson } from "../src/tasks/export";
import { goldProposalIds, publicFiles } from "../src/tasks/public_export";
import { CONSENSUS_EXPORT_SQL, EXPORT_SQL, PHIST_GOLD_EXPORT_SQL, POINTED_DROPS_SQL, VERIFY_VOTES_SQL, toPointedDrop, type PointedDropRow, toBatch, toCredit, toDecision, toProposal, toVerifyVote, type BatchRow, type CreditRow, type DecisionRow, type ProposalRow, type VerifyVoteRow } from "../src/tasks/rows";
import { parseArgs, str, target } from "./lib/args";
import { inline } from "./lib/sql";
import { d1Query } from "./lib/wrangler";

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const batchId = str(flags, "batch");
  const t = target(flags);
  const out = resolve(str(flags, "out", "out"));
  const one = <T>(sql: string) => d1Query<T>(t, inline(sql, batchId))[0] ?? [];
  const batchRow = one<BatchRow>(EXPORT_SQL.batch)[0];
  if (!batchRow) throw new Error(`no batch ${batchId} in ${t}`);
  if (batchRow.task_type === SYNTH_REALISM) {
    if (flags.public === true || t !== "local") throw new Error("synth_realism exports are private and local only");
    const batch = toBatch(batchRow);
    const file = realismExport(batchId, one<RealismRow>(REALISM_EXPORT_SQL), new Date().toISOString(), batch.source.fixture === true);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, EXPORT_FILE), formatJson(file), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ batch: batchId, files: [EXPORT_FILE], decisions: file.decisions.length }));
    return;
  }
  const proposals = one<ProposalRow>(EXPORT_SQL.proposals).map(toProposal);
  const result = buildExport({
    batch: toBatch(batchRow),
    proposals,
    decisions: one<DecisionRow>(EXPORT_SQL.decisions).map(toDecision),
    credits: one<CreditRow>(EXPORT_SQL.credits).map(toCredit),
    ...(batchRow.task_type === "line_verify"
      ? {
          pointedDrops: one<PointedDropRow>(POINTED_DROPS_SQL).map(toPointedDrop),
          triagePlants: one<TriagePlantRow>(TRIAGE_PLANTS_SQL).map(toTriagePlant),
          triagePages: toTriagePages(one<TriagePageRow>(TRIAGE_PAGES_SQL), one<PageCheckRow>(PAGE_CHECKS_SQL), one<AddedLineRow>(ADDED_LINES_SQL)),
        }
      : {}),
    ...(batchRow.task_type === "line_consensus"
      ? {
          exclusions: one<{ reviewer_id: string; excluded_at: string }>(CONSENSUS_EXPORT_SQL.exclusions).map((r) => ({ reviewerId: r.reviewer_id, excludedAt: r.excluded_at })),
          maintainerDecisions: one<{ decision_id: string }>(CONSENSUS_EXPORT_SQL.maintainer).map((r) => r.decision_id),
        }
      : batchRow.task_type === "line_verify" && (batchRow.resolution === "volunteer_v1" || batchRow.resolution === "volunteer_v1_1")
        ? {
            verifyVotes: one<VerifyVoteRow>(VERIFY_VOTES_SQL).map(toVerifyVote),
            ...(batchRow.resolution === "volunteer_v1_1"
              ? {
                  phistGold: {
                    grades: one<{ decision_id: string; gold_id: string; hit: number }>(PHIST_GOLD_EXPORT_SQL.grades).map((g) => ({ decisionId: g.decision_id, goldId: g.gold_id, hit: g.hit === 1 })),
                    pulled: one<{ gold_id: string }>(PHIST_GOLD_EXPORT_SQL.pulled).map((p) => p.gold_id),
                  },
                }
              : {}),
          }
        : {}),
    exportedAt: new Date().toISOString(),
  });
  if (result.problems.length) throw new Error(`the export does not validate:\n  ${result.problems.slice(0, 20).join("\n  ")}`);
  mkdirSync(out, { recursive: true });
  const files = flags.public === true ? publicFiles(result.decisionsFile, result.ledgerFile, goldProposalIds(proposals)) : [result.decisionsFile, result.ledgerFile, ...result.extraFiles];
  for (const f of files) writeFileSync(join(out, f.fileName), formatJson(f.content));
  console.log(JSON.stringify({ batch: batchId, target: t, out, public: flags.public === true, files: files.map((f) => f.fileName), counts: result.counts }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
