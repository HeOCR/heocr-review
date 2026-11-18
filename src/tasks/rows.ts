/** Row shapes, mappers and SQL shared by the Worker (D1 binding) and scripts/export.ts (wrangler d1 execute). */
import type { BatchRecord, Credit, DecisionRecord, ProposalMedia, ProposalRecord } from "./types";


export interface BatchRow {
  id: string;
  task_type: string;
  title: string;
  source_json: string;
  min_reviewers: number;
  status: string;
  /** From batch_settings (null: no row, the default). */
  pass2_reviewer?: string | null;
  pass2_reviewer_set_at?: string | null;
  two_typings_groups?: string | null;
  two_typings_set_at?: string | null;
  resolution?: string | null;
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
    settings: {
      pass2Reviewer: row.pass2_reviewer === "other" ? "other" : "same",
      pass2ReviewerSetAt: row.pass2_reviewer_set_at ?? null,
      twoTypingsGroups: row.two_typings_groups ? (JSON.parse(row.two_typings_groups) as string[]) : [],
      twoTypingsSetAt: row.two_typings_set_at ?? null,
      resolution: row.resolution === "volunteer_v1" ? "volunteer_v1" : "single",
    },
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

export const BATCH_SQL = `SELECT id, task_type, title, source_json, min_reviewers, status,
  (SELECT s.pass2_reviewer FROM batch_settings s WHERE s.batch_id = batches.id) AS pass2_reviewer,
  (SELECT s.updated_at FROM batch_settings s WHERE s.batch_id = batches.id) AS pass2_reviewer_set_at,
  (SELECT s.two_typings_groups FROM batch_settings s WHERE s.batch_id = batches.id) AS two_typings_groups,
  (SELECT s.two_typings_set_at FROM batch_settings s WHERE s.batch_id = batches.id) AS two_typings_set_at,
  (SELECT s.resolution FROM batch_settings s WHERE s.batch_id = batches.id) AS resolution
  FROM batches`;
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
/** line_consensus: the export's extra inputs (migrations/0005_line_consensus.sql). */
export const CONSENSUS_EXPORT_SQL = {
  exclusions: "SELECT reviewer_id, excluded_at FROM agreement_exclusions WHERE batch_id = ?1",
  maintainer: `SELECT m.decision_id FROM maintainer_decisions m JOIN decisions d ON d.id = m.decision_id
    JOIN proposals p ON p.id = d.proposal_id WHERE p.batch_id = ?1`,
};

/** line_verify volunteer_v1: every decision's verify_votes row in a batch. */
export const VERIFY_VOTES_SQL = `SELECT v.decision_id, v.counted, v.not_counted_reason, v.step, v.by_admin FROM verify_votes v
  JOIN proposals p ON p.id = v.proposal_id WHERE p.batch_id = ?1`;

export interface VerifyVoteRow {
  decision_id: string;
  counted: number;
  not_counted_reason: string | null;
  step: string;
  by_admin: number;
}

export const toVerifyVote = (r: VerifyVoteRow) => ({ decisionId: r.decision_id, counted: r.counted === 1, notCountedReason: r.not_counted_reason, step: r.step, byAdmin: r.by_admin === 1 });

export const EXPORT_SQL = {
  batch: `${BATCH_SQL} WHERE id = ?1`,
  proposals: `SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id WHERE p.batch_id = ?1 ORDER BY p.rank`,
  decisions: `${DECISION_SQL} WHERE proposal_id IN (SELECT id FROM proposals WHERE batch_id = ?1)`,
  credits: `SELECT id AS reviewer_id, display_name, display_name_consented_at FROM reviewers
    WHERE display_name IS NOT NULL AND id IN (SELECT reviewer_id FROM decisions WHERE proposal_id IN
    (SELECT id FROM proposals WHERE batch_id = ?1))`,
};
