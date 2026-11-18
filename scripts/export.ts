/**
 * Export a batch's decisions from D1 in the consumer's format, plus the full ledger.
 *
 *   npm run export -- --batch e2d4_reference_audit_v1 [--target local|preview|production] [--out out/]
 *
 * Writes the task type's decisions file (reference_audit_decisions.json: exactly hocrgen's
 * reference_audit_decisions.v1; line_verify_decisions.json: line_verify_decisions.v1), one decision per reviewer per
 * proposal, and <name>_ledger.json (every decision of every reviewer, reviewer counts, conflicts, and opted-in
 * credits). Validates the decisions file before writing; prints counts only.
 * Then copy the decisions file over hocrgen's docs/reference_audit_decisions.json in a PR, and check it there:
 *   python -m hocrgen.tools.reference_audit --decisions docs/reference_audit_decisions.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExport, formatJson } from "../src/tasks/export";
import { standingOf, standingsOf } from "../src/tasks/line_consensus";
import { gateBatchOf } from "../src/tasks/line_transcribe";
import type { DecisionRecord, ProposalRecord } from "../src/tasks/types";
import { CONSENSUS_EXPORT_SQL, EXPORT_SQL, toBatch, toCredit, toDecision, toProposal, type BatchRow, type CreditRow, type DecisionRow, type ProposalRow } from "../src/tasks/rows";
import { parseArgs, str, target } from "./lib/args";
import { inline } from "./lib/sql";
import { d1Query } from "./lib/wrangler";

/**
 * Transcription: each of the batch's reviewers' standing in the gate batch, from that batch's gold decisions and
 * admin exclusions (read-only), as the Worker routes them.
 */
function gateStandings(query: <T>(sql: string, id: string) => T[], gateId: string, decisions: DecisionRecord[]): Record<string, string> {
  const gold = new Map<number, ProposalRecord>(
    query<ProposalRow>(EXPORT_SQL.proposals, gateId)
      .map(toProposal)
      .filter((p) => (p.payload as { gold?: unknown }).gold != null)
      .map((p) => [p.id, p]),
  );
  const answers = query<DecisionRow>(EXPORT_SQL.decisions, gateId)
    .map(toDecision)
    .filter((d) => d.supersededAt === null && gold.has(d.proposalId))
    .map((d) => ({ reviewerId: d.reviewerId, value: d.value, text: d.text, proposal: gold.get(d.proposalId)! }));
  const excluded = new Set(query<{ reviewer_id: string }>(CONSENSUS_EXPORT_SQL.exclusions, gateId).map((r) => r.reviewer_id));
  const st = standingsOf(answers, excluded);
  return Object.fromEntries([...new Set(decisions.map((d) => d.reviewerId))].map((id) => [id, standingOf(st, id).state]));
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const batchId = str(flags, "batch");
  const t = target(flags);
  const out = resolve(str(flags, "out", "out"));
  const query = <T>(sql: string, id: string) => d1Query<T>(t, inline(sql, id))[0] ?? [];
  const one = <T>(sql: string) => query<T>(sql, batchId);
  const batchRow = one<BatchRow>(EXPORT_SQL.batch)[0];
  if (!batchRow) throw new Error(`no batch ${batchId} in ${t}`);
  const batch = toBatch(batchRow);
  const decisions = one<DecisionRow>(EXPORT_SQL.decisions).map(toDecision);
  const consensus = batchRow.task_type === "line_consensus" || batchRow.task_type === "line_transcribe";
  const result = buildExport({
    batch,
    proposals: one<ProposalRow>(EXPORT_SQL.proposals).map(toProposal),
    decisions,
    credits: one<CreditRow>(EXPORT_SQL.credits).map(toCredit),
    ...(batchRow.task_type === "line_transcribe" ? { standings: gateStandings(query, gateBatchOf(batch), decisions) } : {}),
    ...(consensus
      ? {
          exclusions: one<{ reviewer_id: string; excluded_at: string }>(CONSENSUS_EXPORT_SQL.exclusions).map((r) => ({ reviewerId: r.reviewer_id, excludedAt: r.excluded_at })),
          maintainerDecisions: one<{ decision_id: string }>(CONSENSUS_EXPORT_SQL.maintainer).map((r) => r.decision_id),
        }
      : {}),
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
