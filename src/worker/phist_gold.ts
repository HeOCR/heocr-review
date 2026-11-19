/**
 * line_verify P-hist gold in the Worker (docs/specs/line_verify_phist_gold_v1_1.md): which gold line a reviewer is
 * due, what a gold decision records, and the second standing gate. The rules are in src/tasks/line_verify/gold.ts;
 * this file only reads and writes D1 (migrations/0010_phist_gold.sql).
 */
import { goldDue, goldHit, goldOrder, phistReason, scheduleSeed, type GoldMark, type PhistReason } from "../tasks/line_verify/gold";
import type { LineVerifyPayload } from "../tasks/line_verify/index";
import { PHIST_GOLD_EXPORT_SQL, PROPOSAL_COLUMNS, toProposal, type ProposalRow } from "../tasks/rows";
import type { BatchRecord, PhistGoldGrade, ProposalRecord } from "../tasks/types";

export const isVolunteerV11 = (batch: BatchRecord) => batch.taskType === "line_verify" && batch.settings?.resolution === "volunteer_v1_1";

/** A proposal's gold mark (null on a normal line). Never sent to the browser: toView picks its fields. */
export const goldOf = (p: ProposalRecord): GoldMark | null => ((p.payload as { gold?: GoldMark }).gold ?? null);

/** SQL: proposal p is a normal line, not gold (the normal queue and progress leave gold out). */
export const NOT_GOLD = "json_extract(p.payload_json, '$.gold') IS NULL";

const V11_BATCHES = "(SELECT batch_id FROM batch_settings WHERE resolution = 'volunteer_v1_1')";

/** The gold line due for this reviewer in this batch now, if any (each gold_id at most once; none once used up). */
export async function dueGold(db: D1Database, batch: BatchRecord, reviewerId: string): Promise<ProposalRecord | null> {
  const n = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM decisions d JOIN proposals p ON p.id = d.proposal_id
       WHERE d.reviewer_id = ?1 AND d.superseded_at IS NULL AND p.batch_id IN ${V11_BATCHES}`,
    )
    .bind(reviewerId)
    .first<{ n: number }>();
  if (!goldDue(n?.n ?? 0, scheduleSeed(reviewerId))) return null;
  const { results } = await db
    .prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id
       WHERE p.batch_id = ?1 AND p.active = 1 AND json_extract(p.payload_json, '$.gold') IS NOT NULL
         AND json_extract(p.payload_json, '$.gold.gold_id') NOT IN (SELECT gold_id FROM phist_gold_grades WHERE reviewer_id = ?2)
         AND json_extract(p.payload_json, '$.gold.gold_id') NOT IN (SELECT gold_id FROM phist_gold_pulls WHERE pulled = 1)`,
    )
    .bind(batch.id, reviewerId)
    .all<ProposalRow>();
  const pool = new Map(results.map(toProposal).map((p) => [goldOf(p)!.gold_id, p]));
  const first = goldOrder(reviewerId, [...pool.keys()])[0];
  return first === undefined ? null : pool.get(first)!;
}

/** Whether the reviewer has already decided this gold line, in any volunteer_v1_1 batch. */
export async function goldDecided(db: D1Database, reviewerId: string, goldId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM phist_gold_grades WHERE reviewer_id = ?1 AND gold_id = ?2").bind(reviewerId, goldId).first();
  return row !== null;
}

/** Grade a new gold decision and store the grade (never regraded). */
export async function recordGoldDecision(
  db: D1Database,
  proposal: ProposalRecord,
  decisionId: string,
  reviewerId: string,
  decision: { value: string; text: string | null },
  nowIso: string,
): Promise<boolean> {
  const gold = goldOf(proposal)!;
  const x = proposal.payload as unknown as LineVerifyPayload;
  const hit = goldHit(decision, x.candidate_text, x.kind ?? "verify", gold.answer);
  await db
    .prepare("INSERT INTO phist_gold_grades (decision_id, proposal_id, reviewer_id, gold_id, hit, graded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(decisionId, proposal.id, reviewerId, gold.gold_id, hit ? 1 : 0, nowIso)
    .run();
  return hit;
}

/** The second gate now: the reviewer's graded gold decisions on lines not pulled at this moment. */
export async function phistReasonFor(db: D1Database, reviewerId: string): Promise<PhistReason | null> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS graded, COALESCE(SUM(g.hit), 0) AS hits FROM phist_gold_grades g
       WHERE g.reviewer_id = ?1 AND g.gold_id NOT IN (SELECT gold_id FROM phist_gold_pulls WHERE pulled = 1)`,
    )
    .bind(reviewerId)
    .first<{ graded: number; hits: number }>();
  return phistReason(row?.graded ?? 0, row?.hits ?? 0);
}

/** Pull a gold line (or put it back). Forward-only: stored decisions keep what they recorded. */
export async function setPull(db: D1Database, goldId: string, pulled: boolean, reason: string | null, by: string, nowIso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO phist_gold_pulls (gold_id, pulled, reason, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (gold_id) DO UPDATE SET pulled = excluded.pulled, reason = excluded.reason, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(goldId, pulled ? 1 : 0, reason, nowIso, by)
    .run();
}

/** Whether any volunteer_v1_1 batch holds this gold line (an admin may pull only a known one). */
export async function goldKnown(db: D1Database, goldId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM proposals p WHERE p.batch_id IN ${V11_BATCHES} AND json_extract(p.payload_json, '$.gold.gold_id') = ?1 LIMIT 1`)
    .bind(goldId)
    .first();
  return row !== null;
}

export async function phistGoldExtras(db: D1Database, batchId: string): Promise<{ phistGold: { grades: PhistGoldGrade[]; pulled: string[] } }> {
  const grades = (await db.prepare(PHIST_GOLD_EXPORT_SQL.grades).bind(batchId).all<{ decision_id: string; gold_id: string; hit: number }>()).results;
  const pulled = (await db.prepare(PHIST_GOLD_EXPORT_SQL.pulled).all<{ gold_id: string }>()).results;
  return { phistGold: { grades: grades.map((g) => ({ decisionId: g.decision_id, goldId: g.gold_id, hit: g.hit === 1 })), pulled: pulled.map((p) => p.gold_id) } };
}
