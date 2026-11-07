/** Which proposal a reviewer sees next, and progress counts. */
import type { NextResponse, Progress, ProposalView } from "../shared/api";
import { imageUrl } from "../shared/media";
import { PROPOSAL_COLUMNS, toProposal, type ProposalRow } from "../tasks/rows";
import { taskType } from "../tasks/registry";
import type { BatchRecord, ProposalRecord } from "../tasks/types";

/** How long a served proposal stays leased to its reviewer before others are offered it first. */
export const LEASE_MS = 10 * 60 * 1000;
const PREFETCH = 3;

/**
 * Open to reviewer ?2: active, not decided by them, not skipped by them, and below the batch's reviewer target.
 * Proposals leased to someone else in the last LEASE_MS come after the rest; then by rank (the
 * task type's serving order, set at import).
 */
const OPEN_SQL = `SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id
  WHERE p.batch_id = ?1 AND p.active = 1
    AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2 AND d.superseded_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.proposal_id = p.id AND s.reviewer_id = ?2)
    AND (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL) < ?3
  ORDER BY EXISTS (SELECT 1 FROM assignments a WHERE a.proposal_id = p.id AND a.reviewer_id <> ?2 AND a.assigned_at > ?4),
    p.rank
  LIMIT ?5`;

export async function progressFor(db: D1Database, batch: BatchRecord, reviewerId: string): Promise<Progress> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM proposals WHERE batch_id = ?1 AND active = 1) AS total,
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND
          (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL) >= ?3) AS covered,
        (SELECT COUNT(*) FROM decisions d JOIN proposals p ON p.id = d.proposal_id
          WHERE p.batch_id = ?1 AND p.active = 1 AND d.reviewer_id = ?2 AND d.superseded_at IS NULL) AS mine,
        (SELECT COUNT(*) FROM skips s JOIN proposals p ON p.id = s.proposal_id
          WHERE p.batch_id = ?1 AND p.active = 1 AND s.reviewer_id = ?2) AS skipped,
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2 AND d.superseded_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.proposal_id = p.id AND s.reviewer_id = ?2)
          AND (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL) < ?3) AS remaining`,
    )
    .bind(batch.id, reviewerId, batch.minReviewers)
    .first<{ total: number; covered: number; mine: number; skipped: number; remaining: number }>();
  return {
    total: row?.total ?? 0,
    covered: row?.covered ?? 0,
    minReviewers: batch.minReviewers,
    decidedByMe: row?.mine ?? 0,
    skippedByMe: row?.skipped ?? 0,
    remainingForMe: row?.remaining ?? 0,
  };
}

export async function proposalView(db: D1Database, batch: BatchRecord, p: ProposalRecord, reviewerId: string): Promise<ProposalView> {
  const type = taskType(batch.taskType);
  if (!type) throw new Error(`unknown task type ${batch.taskType}`);
  const mine = await db
    .prepare("SELECT value, text, decided_on FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL")
    .bind(p.id, reviewerId)
    .first<{ value: string; text: string | null; decided_on: string }>();
  return {
    id: p.id,
    batchId: p.batchId,
    externalId: p.externalId,
    itemTitle: p.itemTitle,
    view: type.toView(p),
    options: type.options,
    mine: mine ? { value: mine.value, text: mine.text, decidedAt: mine.decided_on } : null,
  };
}

export async function nextFor(db: D1Database, batch: BatchRecord, reviewerId: string, nowMs = Date.now()): Promise<NextResponse> {
  const { results } = await db
    .prepare(OPEN_SQL)
    .bind(batch.id, reviewerId, batch.minReviewers, nowMs - LEASE_MS, 1 + PREFETCH)
    .all<ProposalRow>();
  const rows = results.map(toProposal);
  const progress = await progressFor(db, batch, reviewerId);
  const first = rows[0];
  if (!first) return { proposal: null, progress, prefetch: [] };
  await db
    .prepare(
      `INSERT INTO assignments (proposal_id, reviewer_id, assigned_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (proposal_id, reviewer_id) DO UPDATE SET assigned_at = excluded.assigned_at`,
    )
    .bind(first.id, reviewerId, nowMs)
    .run();
  const kinds = taskType(batch.taskType)?.prefetch ?? ["crop", "page"];
  const prefetch = rows
    .slice(1)
    .flatMap((r) => kinds.map((k) => r.media[k]))
    .filter((m) => m !== undefined)
    .map((m) => imageUrl(m.ref));
  return { proposal: await proposalView(db, batch, first, reviewerId), progress, prefetch: [...new Set(prefetch)] };
}
