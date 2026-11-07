/** Row shapes, mappers and SQL shared by the Worker (D1 binding) and scripts/export.ts (wrangler d1 execute). */
import type { BatchRecord, Credit, DecisionRecord, ProposalMedia, ProposalRecord } from "./types";


export interface BatchRow {
  id: string;
  task_type: string;
  title: string;
  source_json: string;
  min_reviewers: number;
  status: string;
}

export interface ProposalRow {
  id: number;
  batch_id: string;
  external_id: string;
  item_external_id: string;
  item_title: string;
  category: string;
  confidence: string;
  rank: number;
  payload_json: string;
  media_json: string;
  content_sha256: string;
  active: number;
}

export interface DecisionRow {
  id: string;
  proposal_id: number;
  reviewer_id: string;
  value: string;
  text: string | null;
  proposal_sha256: string;
  terms_version: string;
  created_at: string;
  decided_on: string;
  superseded_at: string | null;
}

export function toBatch(row: BatchRow): BatchRecord & { status: string } {
  return {
    id: row.id,
    taskType: row.task_type,
    title: row.title,
    source: JSON.parse(row.source_json) as Record<string, unknown>,
    minReviewers: row.min_reviewers,
    status: row.status,
  };
}

export function toProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    externalId: row.external_id,
    itemExternalId: row.item_external_id,
    itemTitle: row.item_title,
    category: row.category,
    confidence: row.confidence,
    rank: row.rank,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    media: JSON.parse(row.media_json) as ProposalMedia,
    contentSha256: row.content_sha256,
    active: row.active === 1,
  };
}

export function toDecision(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    reviewerId: row.reviewer_id,
    value: row.value,
    text: row.text,
    proposalSha256: row.proposal_sha256,
    termsVersion: row.terms_version,
    createdAt: row.created_at,
    decidedOn: row.decided_on,
    supersededAt: row.superseded_at,
  };
}

/** Columns that make a ProposalRecord (proposals p JOIN items i). */
export const PROPOSAL_COLUMNS = `p.id, p.batch_id, p.external_id, i.external_id AS item_external_id, i.title AS item_title,
  p.category, p.confidence, p.rank, p.payload_json, p.media_json, p.content_sha256, p.active`;

export const BATCH_SQL = "SELECT id, task_type, title, source_json, min_reviewers, status FROM batches";
export const DECISION_SQL = `SELECT id, proposal_id, reviewer_id, value, text, proposal_sha256, terms_version, created_at,
  decided_on, superseded_at FROM decisions`;

export interface CreditRow {
  reviewer_id: string;
  display_name: string;
  display_name_consented_at: string;
}

export function toCredit(r: CreditRow): Credit {
  return { reviewerId: r.reviewer_id, displayName: r.display_name, consentedAt: r.display_name_consented_at };
}

/** The three export queries for a batch; `?1` is the batch id. */
export const EXPORT_SQL = {
  batch: `${BATCH_SQL} WHERE id = ?1`,
  proposals: `SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id WHERE p.batch_id = ?1 ORDER BY p.rank`,
  decisions: `${DECISION_SQL} WHERE proposal_id IN (SELECT id FROM proposals WHERE batch_id = ?1)`,
  credits: `SELECT id AS reviewer_id, display_name, display_name_consented_at FROM reviewers
    WHERE display_name IS NOT NULL AND id IN (SELECT reviewer_id FROM decisions WHERE proposal_id IN
    (SELECT id FROM proposals WHERE batch_id = ?1))`,
};
