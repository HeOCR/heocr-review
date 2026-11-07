import {
  BATCH_SQL,
  EXPORT_SQL,
  PROPOSAL_COLUMNS,
  toBatch,
  toCredit,
  toDecision,
  toProposal,
  type BatchRow,
  type CreditRow,
  type DecisionRow,
  type ProposalRow,
} from "../tasks/rows";
import type { ProposalRecord } from "../tasks/types";

export interface ReviewerRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  terms_version: string | null;
  terms_accepted_at: string | null;
  display_name: string | null;
  display_name_consented_at: string | null;
  blocked: number;
}

export async function getBatch(db: D1Database, id: string) {
  const row = await db.prepare(`${BATCH_SQL} WHERE id = ?1`).bind(id).first<BatchRow>();
  return row ? toBatch(row) : null;
}

export async function listBatches(db: D1Database, openOnly: boolean) {
  const { results } = await db.prepare(`${BATCH_SQL}${openOnly ? " WHERE status = 'open'" : ""} ORDER BY imported_at, id`).all<BatchRow>();
  return results.map(toBatch);
}

export async function getProposal(db: D1Database, id: number): Promise<ProposalRecord | null> {
  const row = await db
    .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id WHERE p.id = ?1`)
    .bind(id)
    .first<ProposalRow>();
  return row ? toProposal(row) : null;
}

export async function getReviewer(db: D1Database, id: string): Promise<ReviewerRow | null> {
  return db.prepare("SELECT * FROM reviewers WHERE id = ?1").bind(id).first<ReviewerRow>();
}

export async function exportRows(db: D1Database, batchId: string) {
  const [proposals, decisions, credits] = await db.batch([
    db.prepare(EXPORT_SQL.proposals).bind(batchId),
    db.prepare(EXPORT_SQL.decisions).bind(batchId),
    db.prepare(EXPORT_SQL.credits).bind(batchId),
  ]);
  return {
    proposals: (proposals!.results as unknown as ProposalRow[]).map(toProposal),
    decisions: (decisions!.results as unknown as DecisionRow[]).map(toDecision),
    credits: (credits!.results as unknown as CreditRow[]).map(toCredit),
  };
}
