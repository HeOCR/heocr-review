import { RANKING_MAPPING_VERSION, RANKING_TIE, type RankingPair, type RankingQueue, type Side } from "../shared/synth_realism";
import { RANKING_EXPORT_FILE, RANKING_EXPORT_SQL, rankingExport, type RankingRow } from "../tasks/synth_realism/ranking-export";
import type { BatchRecord } from "../tasks/types";
import { HttpError, json } from "./http";
import { realismImage } from "./synth_realism";

const completedSql = `SELECT COUNT(*) FROM synth_ranking_answers WHERE batch_id=?1 AND reviewer_id=?2 AND choice IS NOT NULL`;
const totalSql = `SELECT COUNT(*) FROM synth_ranking_pairs WHERE batch_id=?1`;
const revisionSql = `SELECT revision FROM synth_ranking_answers WHERE batch_id=?1 AND reviewer_id=?2 AND position=`;

export async function rankingProgress(db: D1Database, batch: string, reviewer: string) {
  return (await db.prepare(`SELECT (${totalSql}) AS total, (${completedSql}) AS completed`)
    .bind(batch, reviewer).first<{ total: number; completed: number }>())!;
}

function pairView(batch: string, position: number, revision: number): RankingPair {
  const path = `/api/realism-ranking/${batch}/pairs/${position}/image`;
  return { position, revision, images: [`${path}/0`, `${path}/1`] };
}

export async function rankingState(db: D1Database, batch: string, reviewer: string): Promise<RankingQueue> {
  const state = (await db.prepare(`WITH progress AS (SELECT (${totalSql}) AS total, (${completedSql}) AS completed)
    SELECT total, completed, (${revisionSql} completed) AS previous_revision,
      COALESCE((${revisionSql} completed+1),0) AS current_revision,
      COALESCE((${revisionSql} completed+2),0) AS next_revision
    FROM progress`).bind(batch, reviewer).first<{
      total: number; completed: number; previous_revision: number | null; current_revision: number; next_revision: number;
    }>())!;
  const { total, completed } = state;
  return {
    total, completed,
    current: completed < total ? pairView(batch, completed + 1, state.current_revision) : null,
    next: completed + 1 < total ? pairView(batch, completed + 2, state.next_revision) : null,
    previous: state.previous_revision === null ? null : { position: completed, revision: state.previous_revision },
  };
}

async function rankingSwap(batch: string, reviewer: string, position: number) {
  // Immutable input makes the layout consistent across reloads, tabs, retries, and undo.
  const salt = new TextEncoder().encode(JSON.stringify([batch, reviewer, position]));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", salt))[0]! % 2;
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "invalid_decision");
  return value;
}

export async function rankChoice(db: D1Database, batch: string, reviewer: string, position: number, body: Record<string, unknown>, now: number) {
  const revision = version(body.revision);
  const { choice, latency_ms } = body;
  if ((choice !== 0 && choice !== 1 && choice !== RANKING_TIE) || typeof latency_ms !== "number" || !Number.isSafeInteger(latency_ms) ||
    latency_ms < 0 || latency_ms > 86_400_000) throw new HttpError(400, "invalid_decision");
  const mapping = body.mapping_version === undefined ? 1 : body.mapping_version;
  const assetOrder = pairView(batch, position, revision).images;
  if ((mapping === 1 && body.left_asset !== undefined) ||
    (mapping === RANKING_MAPPING_VERSION && body.left_asset !== assetOrder[0] && body.left_asset !== assetOrder[1]) ||
    (mapping !== 1 && mapping !== RANKING_MAPPING_VERSION)) throw new HttpError(400, "invalid_decision");
  const swapped = (await rankingSwap(batch, reviewer, position)) ^ Number(body.left_asset === assetOrder[1]);
  const tieAvailable = choice === RANKING_TIE || body.tie_available === true ? 1 : 0;
  // The prefix and revision predicates are in the write, so a retry or stale tab cannot answer a different pair.
  await db.prepare(`INSERT INTO synth_ranking_answers (batch_id,reviewer_id,position,revision,choice,swapped,latency_ms,chosen_at,tie_available,mapping_version)
    SELECT ?1,?2,?3,?4+1,?5,?6,?7,?8,?9,?10
    WHERE ?3=(${completedSql})+1 AND ?4=COALESCE((${revisionSql} ?3),0)
      AND EXISTS (SELECT 1 FROM synth_ranking_pairs WHERE batch_id=?1 AND position=?3)
      AND EXISTS (SELECT 1 FROM batches WHERE id=?1 AND status='open')
    ON CONFLICT(batch_id,reviewer_id,position) DO UPDATE SET revision=excluded.revision, choice=excluded.choice,
      latency_ms=excluded.latency_ms, chosen_at=excluded.chosen_at, swapped=excluded.swapped,
      tie_available=excluded.tie_available, mapping_version=excluded.mapping_version`)
    .bind(batch, reviewer, position, revision, choice, swapped, latency_ms, now, tieAvailable, mapping).run();
  return rankingState(db, batch, reviewer);
}

export async function rankUndo(db: D1Database, batch: string, reviewer: string, position: number, body: Record<string, unknown>) {
  const revision = version(body.revision);
  await db.prepare(`UPDATE synth_ranking_answers SET revision=revision+1, choice=NULL, latency_ms=NULL, chosen_at=NULL, tie_available=0
    WHERE batch_id=?1 AND reviewer_id=?2 AND position=?3 AND revision=?4 AND choice IS NOT NULL
      AND ?3=(${completedSql})
      AND EXISTS (SELECT 1 FROM batches WHERE id=?1 AND status='open')`)
    .bind(batch, reviewer, position, revision).run();
  return rankingState(db, batch, reviewer);
}

export async function rankAsset(db: D1Database, batch: string, reviewer: string, position: number, side: Side) {
  const row = await db.prepare(`SELECT image_a, image_b FROM synth_ranking_pairs WHERE batch_id=?1 AND position=?3
      AND ?3 BETWEEN (${completedSql}) AND (${completedSql})+2`)
    .bind(batch, reviewer, position).first<{ image_a: string; image_b: string }>();
  if (!row) throw new HttpError(404, "not_found");
  return realismImage(db, side === await rankingSwap(batch, reviewer, position) ? row.image_a : row.image_b);
}

export async function rankingAdmin(db: D1Database, batch: BatchRecord, now: number) {
  const { results } = await db.prepare(RANKING_EXPORT_SQL).bind(batch.id).all<RankingRow>();
  const { total } = await rankingProgress(db, batch.id, "");
  const counts = { items: total, choices: results.length, completed: results.length };
  const perReviewer = new Map<string, number>();
  for (const row of results) perReviewer.set(row.reviewer, (perReviewer.get(row.reviewer) ?? 0) + 1);
  return {
    counts, reviewers: [...perReviewer].map(([id, decisions]) => ({ id, decisions })),
    export: () => json({ counts, problems: [], files: {
      [RANKING_EXPORT_FILE]: rankingExport(batch.id, results, new Date(now).toISOString(), batch.source.fixture === true,
        batch.source.ranking_arm_modalities),
    } }),
  };
}
