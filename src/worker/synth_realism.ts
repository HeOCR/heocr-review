import { TAGS, type RealismQueue, type RealismTrial, type Side } from "../shared/synth_realism";
import { textProblem, type BatchRecord } from "../tasks/types";
import { EXPORT_FILE, REALISM_EXPORT_SQL, realismExport, type RealismRow } from "../tasks/synth_realism/export";
import type { RealismItem } from "../tasks/synth_realism/schema";
import { randomId } from "./crypto";
import { HttpError, json } from "./http";

interface TrialRow {
  id: string;
  swapped: Side;
  choice: Side | null;
  completed_at: number | null;
  control_kind: RealismItem["control_kind"];
  synthetic_image: string;
  synthetic_line_crop: string;
  real_ref_image: string;
  real_ref_line_crop: string;
}

const trialSql = `SELECT t.id, t.swapped, t.choice, t.completed_at, i.control_kind,
  i.synthetic_image, i.synthetic_line_crop, i.real_ref_image, i.real_ref_line_crop
  FROM synth_realism_trials t JOIN synth_realism_items i ON i.id = t.item_id
  WHERE t.batch_id = ?1 AND t.reviewer_id = ?2`;

export async function realismProgress(db: D1Database, batch: string, reviewer: string) {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM synth_realism_items WHERE batch_id = ?1) AS total,
    (SELECT COUNT(*) FROM synth_realism_trials WHERE batch_id = ?1 AND reviewer_id = ?2 AND completed_at IS NOT NULL) AS completed`)
    .bind(batch, reviewer).first<{total: number; completed: number}>();
  return { total: row!.total, completed: row!.completed };
}

function view(batch: string, row: TrialRow): RealismTrial {
  const prefix = `/api/synth-realism/${batch}/trials/${row.id}/asset`;
  return {
    id: row.id,
    pair: [{ page: `${prefix}/0/page`, line: `${prefix}/0/line` }, { page: `${prefix}/1/page`, line: `${prefix}/1/line` }],
    reveal: row.choice === null ? null : { choice: row.choice, synthetic: [
      row.control_kind !== "real_real" && row.swapped === 0,
      row.control_kind !== "real_real" && row.swapped === 1,
    ] },
  };
}

/** Reserve the next unseen pair. A partial unique index makes refreshes and concurrent tabs resume the same trial. */
export async function nextRealism(db: D1Database, batch: string, reviewer: string, now: number): Promise<RealismQueue> {
  const active = () => db.prepare(`${trialSql} AND t.completed_at IS NULL`).bind(batch, reviewer).first<TrialRow>();
  let row = await active();
  if (!row) {
    await db.prepare(`INSERT OR IGNORE INTO synth_realism_trials (id, item_id, batch_id, reviewer_id, swapped, served_at)
      SELECT ?3, i.id, i.batch_id, ?2, ABS(RANDOM() % 2), ?4 FROM synth_realism_items i
      WHERE i.batch_id = ?1 AND NOT EXISTS (
        SELECT 1 FROM synth_realism_trials t WHERE t.item_id = i.id AND t.reviewer_id = ?2
      )
      ORDER BY RANDOM() LIMIT 1`).bind(batch, reviewer, randomId("sr-", 16), now).run();
    row = await active();
  }
  return { ...await realismProgress(db, batch, reviewer), trial: row ? view(batch, row) : null };
}

async function requireTrial(db: D1Database, batch: string, reviewer: string, trial: string): Promise<TrialRow> {
  const row = await db.prepare(`${trialSql} AND t.id = ?3`).bind(batch, reviewer, trial).first<TrialRow>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

/** The first valid choice wins. Send the reveal only after the write; retries return the first choice. */
export async function realismChoice(db: D1Database, batch: string, reviewer: string, trial: string, body: Record<string, unknown>, now: number) {
  const { choice, latency_ms } = body;
  if ((choice !== 0 && choice !== 1) || typeof latency_ms !== "number" || !Number.isSafeInteger(latency_ms) || latency_ms < 0 || latency_ms > 86_400_000) {
    throw new HttpError(400, "invalid_decision");
  }
  await db.prepare(`UPDATE synth_realism_trials SET choice = ?4, chosen_at = ?6,
      latency_ms = MIN(?5, MAX(0, ?6 - served_at))
    WHERE batch_id = ?1 AND reviewer_id = ?2 AND id = ?3 AND choice IS NULL`)
    .bind(batch, reviewer, trial, choice, latency_ms, now).run();
  return view(batch, await requireTrial(db, batch, reviewer, trial));
}

export async function realismFeedback(db: D1Database, batch: string, reviewer: string, trial: string, body: Record<string, unknown>, now: number) {
  const { score, tags, comment } = body;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 10 || !Array.isArray(tags) ||
    tags.length > TAGS.length || new Set(tags).size !== tags.length || tags.some((tag: unknown) => !(TAGS as readonly unknown[]).includes(tag)) ||
    (comment !== undefined && comment !== null && textProblem(comment))) throw new HttpError(400, "invalid_decision");
  const row = await requireTrial(db, batch, reviewer, trial);
  if (row.choice === null) throw new HttpError(409, "not_open");
  await db.prepare(`UPDATE synth_realism_trials SET score = ?4, tags_json = ?5, comment = ?6, completed_at = ?7
    WHERE batch_id = ?1 AND reviewer_id = ?2 AND id = ?3 AND completed_at IS NULL`)
    .bind(batch, reviewer, trial, score, JSON.stringify(tags), typeof comment === "string" ? comment.trim() || null : null, now).run();
  return { ok: true };
}

export async function realismAsset(db: D1Database, batch: string, reviewer: string, trial: string, side: Side, kind: "page" | "line"): Promise<Response> {
  const row = await requireTrial(db, batch, reviewer, trial);
  if (row.completed_at !== null) throw new HttpError(404, "not_found");
  const sha = side === row.swapped
    ? kind === "page" ? row.synthetic_image : row.synthetic_line_crop
    : kind === "page" ? row.real_ref_image : row.real_ref_line_crop;
  return realismImage(db, sha);
}

export async function realismImage(db: D1Database, sha: string): Promise<Response> {
  const { results } = await db.prepare("SELECT base64 FROM synth_realism_assets WHERE sha256 = ?1 ORDER BY part")
    .bind(sha).all<{base64: string}>();
  if (!results.length) throw new HttpError(404, "not_found");
  const bytes = Uint8Array.from(atob(results.map((p) => p.base64).join("")), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: {
    "content-type": "image/jpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  } });
}

export async function realismAdmin(db: D1Database, batch: BatchRecord, now: number) {
  const { results } = await db.prepare(REALISM_EXPORT_SQL).bind(batch.id).all<RealismRow>();
  const { total } = await realismProgress(db, batch.id, "");
  const counts = { items: total, choices: results.length, completed: results.filter((r) => r.completed_at !== null).length };
  const reviewers = new Map<string, number>();
  for (const row of results) reviewers.set(row.reviewer, (reviewers.get(row.reviewer) ?? 0) + 1);
  return {
    counts, reviewers: [...reviewers].map(([id, decisions]) => ({ id, decisions })),
    export: () => json({ counts, problems: [], files: {
      [EXPORT_FILE]: realismExport(batch.id, results, new Date(now).toISOString(), batch.source.fixture === true),
    } }),
  };
}
