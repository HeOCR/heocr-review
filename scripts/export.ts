/**
 * Export a batch's decisions from D1 in the consumer's format, plus the full ledger.
 *
 *   npm run export -- --batch e2d4_reference_audit_v1 [--target local|preview|production] [--out out/]
 *
 * Writes <out>/reference_audit_decisions.json (exactly hocrgen's reference_audit_decisions.v1, one decision per
 * proposal) and <out>/reference_audit_decisions_ledger.json (every decision of every reviewer, reviewer counts,
 * conflicts, and opted-in credits). Validates the decisions file before writing; prints counts only.
 * Then copy the decisions file over hocrgen's docs/reference_audit_decisions.json in a PR, and check it there:
 *   python -m hocrgen.tools.reference_audit --decisions docs/reference_audit_decisions.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExport, formatJson } from "../src/tasks/export";
import { EXPORT_SQL, toBatch, toCredit, toDecision, toProposal, type BatchRow, type CreditRow, type DecisionRow, type ProposalRow } from "../src/tasks/rows";
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
  const result = buildExport({
    batch: toBatch(batchRow),
    proposals: one<ProposalRow>(EXPORT_SQL.proposals).map(toProposal),
    decisions: one<DecisionRow>(EXPORT_SQL.decisions).map(toDecision),
    credits: one<CreditRow>(EXPORT_SQL.credits).map(toCredit),
    exportedAt: new Date().toISOString(),
  });
  if (result.problems.length) throw new Error(`the export does not validate:\n  ${result.problems.slice(0, 20).join("\n  ")}`);
  mkdirSync(out, { recursive: true });
  for (const f of [result.decisionsFile, result.ledgerFile]) writeFileSync(join(out, f.fileName), formatJson(f.content));
  console.log(JSON.stringify({ batch: batchId, target: t, out, files: [result.decisionsFile.fileName, result.ledgerFile.fileName], counts: result.counts }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
