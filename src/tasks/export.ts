/**
 * Resolve every reviewer's decisions and build the export files. Shared by the Worker (admin export) and
 * scripts/export.ts (export from D1 for a hocrgen PR).
 *
 * Policy: every decision is recorded. A reviewer's later decision on the same proposal supersedes their earlier
 * one. A decision made on proposal content that has since changed is stale and never exported. The export emits
 * every reviewer's current decision (one per reviewer per proposal); the consumer applies a proposal when at least
 * min_reviewers of them agree. The ledger records the same outcome per proposal, plus superseded and stale history.
 */
import type { BatchRecord, Credit, DecisionRecord, ExportFile, ProposalRecord, ResolvedProposal } from "./types";
import { taskType } from "./registry";

/**
 * The licence each terms version gave contributions (src/shared/terms.ts). The maintainer released his own decisions
 * under CC0 1.0 whatever their terms version (docs/decisions/2026-11-12-cc0.md).
 */
export const CONTRIBUTION_LICENCES: Record<string, string> = {
  "2026-11-07-draft-1": "CC-BY-SA-4.0",
  "2026-11-07-v1": "CC-BY-SA-4.0",
  "2026-11-12-v1": "CC0-1.0",
};
export const MAINTAINER_RELICENCE = "docs/decisions/2026-11-12-cc0.md";

export const LEDGER_SCHEMA = "heocr_review_decision_ledger.v1";

export interface ExportInput {
  batch: BatchRecord;
  proposals: ProposalRecord[];
  decisions: DecisionRecord[];
  credits: Credit[];
  exportedAt: string;
}

export interface ExportResult {
  decisionsFile: ExportFile;
  ledgerFile: ExportFile;
  counts: Record<string, number>;
  problems: string[];
}

function agreementKey(d: DecisionRecord): string {
  return d.value === "edited" ? `edited\u0000${d.text ?? ""}` : d.value;
}

export function resolveProposals(batch: BatchRecord, proposals: ProposalRecord[], decisions: DecisionRecord[]): ResolvedProposal[] {
  const byProposal = new Map<number, DecisionRecord[]>();
  for (const d of decisions) {
    const list = byProposal.get(d.proposalId) ?? [];
    list.push(d);
    byProposal.set(d.proposalId, list);
  }
  return proposals
    .filter((p) => p.active)
    .map((proposal) => {
      const all = (byProposal.get(proposal.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const live = all.filter((d) => d.supersededAt === null);
      const current = live.filter((d) => d.proposalSha256 === proposal.contentSha256);
      const stale = live.filter((d) => d.proposalSha256 !== proposal.contentSha256);
      const superseded = all.filter((d) => d.supersededAt !== null);
      let status: ResolvedProposal["status"];
      if (current.length === 0) status = "undecided";
      else if (new Set(current.map(agreementKey)).size > 1) status = "conflict";
      else if (current.length < batch.minReviewers) status = "awaiting_reviewers";
      else status = "agreed";
      return { proposal, status, current, stale, superseded };
    });
}

function ledgerDecision(d: DecisionRecord, state: "current" | "stale" | "superseded") {
  return {
    decision_id: d.id,
    reviewer: d.reviewerId,
    decision: d.value,
    ...(d.value === "edited" ? { text: d.text ?? "" } : {}),
    decided_at: d.decidedOn,
    recorded_at: d.createdAt,
    state,
    superseded_at: d.supersededAt,
    terms_version: d.termsVersion,
  };
}

export function buildExport(input: ExportInput): ExportResult {
  const { batch, proposals, decisions, credits, exportedAt } = input;
  const type = taskType(batch.taskType);
  if (!type) throw new Error(`unknown task type ${batch.taskType}`);
  const resolved = resolveProposals(batch, proposals, decisions);
  const decisionsFile = type.exportDecisions(batch, resolved);
  const problems = type.validateExport(batch, proposals, decisionsFile.content);
  const count = (status: ResolvedProposal["status"]) => resolved.filter((r) => r.status === status).length;
  const reviewers = new Set(decisions.map((d) => d.reviewerId));
  const counts = {
    proposals: resolved.length,
    decisions_exported: resolved.reduce((n, r) => n + r.current.length, 0),
    undecided: count("undecided"),
    awaiting_reviewers: count("awaiting_reviewers"),
    agreed: count("agreed"),
    conflict: count("conflict"),
    decisions_recorded: decisions.length,
    decisions_stale: resolved.reduce((n, r) => n + r.stale.length, 0),
    reviewers: reviewers.size,
  };
  const creditFor = new Map(credits.map((c) => [c.reviewerId, c]));
  const ledger = {
    schema_version: LEDGER_SCHEMA,
    batch_id: batch.id,
    task_type: batch.taskType,
    exported_at: exportedAt,
    decisions_file: decisionsFile.fileName,
    policy: {
      min_reviewers: batch.minReviewers,
      rule: "every reviewer's current decision is exported; a proposal applies when at least min_reviewers of them agree (same decision, and for edited the same text)",
      supersede: "a reviewer's later decision on the same proposal supersedes their earlier one",
      stale: "a decision on proposal content that has since changed is never exported",
    },
    counts,
    contribution_licences: {
      by_terms_version: CONTRIBUTION_LICENCES,
      maintainer_relicence: { licence: "CC0-1.0", record: MAINTAINER_RELICENCE, scope: "all of the maintainer's decisions and corrections, past and future" },
    },
    proposals: resolved.map((r) => ({
      proposal_id: r.proposal.externalId,
      item_id: r.proposal.itemExternalId,
      status: r.status,
      reviewer_count: new Set(r.current.map((d) => d.reviewerId)).size,
      decisions: [
        ...r.current.map((d) => ledgerDecision(d, "current")),
        ...r.stale.map((d) => ledgerDecision(d, "stale")),
        ...r.superseded.map((d) => ledgerDecision(d, "superseded")),
      ],
    })),
    credits: [...reviewers]
      .sort()
      .filter((id) => creditFor.has(id))
      .map((id) => ({ reviewer: id, display_name: creditFor.get(id)!.displayName, consented_at: creditFor.get(id)!.consentedAt })),
  };
  const ledgerName = decisionsFile.fileName.replace(/\.json$/, "") + "_ledger.json";
  return { decisionsFile, ledgerFile: { fileName: ledgerName, content: ledger }, counts, problems };
}

/** JSON as hocrgen writes it: one-space indent, UTF-8 (no \u escapes), trailing newline. */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 1) + "\n";
}
