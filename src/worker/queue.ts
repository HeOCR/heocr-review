/** Which proposal a reviewer sees next, and progress counts. */
import type { NextResponse, Progress, ProposalView } from "../shared/api";
import { imageUrl } from "../shared/media";
import { PROPOSAL_COLUMNS, toProposal, type ProposalRow } from "../tasks/rows";
import { taskType } from "../tasks/registry";
import type { BatchRecord, ProposalRecord } from "../tasks/types";
import { assignReserves, type ReserveRow } from "./reserves";

/** How long a served proposal stays leased to its reviewer before others are offered it first. */
export const LEASE_MS = 10 * 60 * 1000;
const PREFETCH = 3;
/** A blind second pass opens this long after the reviewer's first decision on the paired first-pass page. */
export const BLIND_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether proposal p is open to reviewer ?2 under its gate (migrations/0002_proposal_gates.sql). `reserves` binds a
 * JSON array of the reserve proposal ids assigned so far, `cutoff` the ISO time before which a first-pass decision
 * must have been made.
 */
function eligible(reserves: number, cutoff: number): string {
  return `(p.gate_kind IS NULL
    OR (p.gate_kind = 'reserve' AND p.id IN (SELECT value FROM json_each(?${reserves})))
    OR (p.gate_kind = 'after_confirm'
      AND EXISTS (SELECT 1 FROM proposals q JOIN decisions d ON d.proposal_id = q.id
        WHERE q.batch_id = p.batch_id AND q.external_id = p.gate_ref AND q.active = 1 AND d.reviewer_id = ?2
          AND d.superseded_at IS NULL AND d.value = 'confirm' AND d.proposal_sha256 = q.content_sha256)
      AND (SELECT MIN(d.created_at) FROM proposals q JOIN decisions d ON d.proposal_id = q.id
        WHERE q.batch_id = p.batch_id AND q.external_id = p.gate_ref AND d.reviewer_id = ?2) <= ?${cutoff}))`;
}

async function openReserves(db: D1Database, batchId: string): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.category, p.gate_kind,
        EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL AND d.value = 'reject') AS rejected
       FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND (p.gate_kind IS NULL OR p.gate_kind = 'reserve')
       ORDER BY p.rank`,
    )
    .bind(batchId)
    .all<ReserveRow>();
  return assignReserves(results);
}

/** The gate parameters for a batch at a time: the open reserves (JSON) and the blind-pass cutoff (ISO). */
async function gateParams(db: D1Database, batchId: string, nowMs: number): Promise<[string, string]> {
  return [JSON.stringify(await openReserves(db, batchId)), new Date(nowMs - BLIND_DELAY_MS).toISOString()];
}

/** Whether one proposal is open to a reviewer under its gate (a gated page fetched by id before it opens is not). */
export async function isOpenTo(db: D1Database, p: { id: number; batchId: string }, reviewerId: string, nowMs = Date.now()): Promise<boolean> {
  const [reserves, cutoff] = await gateParams(db, p.batchId, nowMs);
  const row = await db
    .prepare(`SELECT 1 AS ok FROM proposals p WHERE p.id = ?1 AND ${eligible(3, 4)}`)
    .bind(p.id, reviewerId, reserves, cutoff)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * Open to reviewer ?2: active, not decided by them, not skipped by them, and below the batch's reviewer target.
 * Proposals leased to someone else in the last LEASE_MS come after the rest; then by rank (the
 * task type's serving order, set at import).
 */
const OPEN_SQL = `SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id
  WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(6, 7)}
    AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2 AND d.superseded_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.proposal_id = p.id AND s.reviewer_id = ?2)
    AND (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL) < ?3
  ORDER BY EXISTS (SELECT 1 FROM assignments a WHERE a.proposal_id = p.id AND a.reviewer_id <> ?2 AND a.assigned_at > ?4),
    p.rank
  LIMIT ?5`;

/** Progress over the proposals open to this reviewer now (gated ones count once they open). */
export async function progressFor(db: D1Database, batch: BatchRecord, reviewerId: string, nowMs = Date.now()): Promise<Progress> {
  const [reserves, cutoff] = await gateParams(db, batch.id, nowMs);
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(4, 5)}) AS total,
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(4, 5)} AND
          (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL) >= ?3) AS covered,
        (SELECT COUNT(*) FROM decisions d JOIN proposals p ON p.id = d.proposal_id
          WHERE p.batch_id = ?1 AND p.active = 1 AND d.reviewer_id = ?2 AND d.superseded_at IS NULL) AS mine,
        (SELECT COUNT(*) FROM skips s JOIN proposals p ON p.id = s.proposal_id
          WHERE p.batch_id = ?1 AND p.active = 1 AND s.reviewer_id = ?2) AS skipped,
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(4, 5)}
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2 AND d.superseded_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.proposal_id = p.id AND s.reviewer_id = ?2)
          AND (SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND d.superseded_at IS NULL) < ?3) AS remaining`,
    )
    .bind(batch.id, reviewerId, batch.minReviewers, reserves, cutoff)
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
  const [reserves, cutoff] = await gateParams(db, batch.id, nowMs);
  const { results } = await db
    .prepare(OPEN_SQL)
    .bind(batch.id, reviewerId, batch.minReviewers, nowMs - LEASE_MS, 1 + PREFETCH, reserves, cutoff)
    .all<ProposalRow>();
  const rows = results.map(toProposal);
  const progress = await progressFor(db, batch, reviewerId, nowMs);
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
