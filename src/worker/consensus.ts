/**
 * Volunteer line review in the Worker (task type line_consensus): who is served which line, line states, standings
 * and the admin's switch. The rules are in src/tasks/line_consensus/consensus.ts; this file only reads and writes D1.
 *
 * Independence: a volunteer is only ever served lines by this queue, sees only their own decision, and the progress
 * they get counts only their own work. The maintainer (an admin) is never served volunteer lines here; they get the
 * lines that went to them.
 */
import type { NextResponse, Progress } from "../shared/api";
import { imageUrl } from "../shared/media";
import { sha256Hex } from "../shared/sha256";
import { goldNext } from "../tasks/line_consensus/consensus";
import { TASK_TYPE_ID as LINE_CONSENSUS, hasBox, isGold, payloadOf, routeLine, standingOf, standingsOf, type StandingRow } from "../tasks/line_consensus";
import { TASK_TYPE_ID as LINE_TRANSCRIBE, forAgreement, gateBatchOf } from "../tasks/line_transcribe";
import { BATCH_SQL, CONSENSUS_EXPORT_SQL, PROPOSAL_COLUMNS, pageFlagsOf, toBatch, toProposal, type BatchRow, type PageFlagAnswerRow, type PageFlagRow, type ProposalRow } from "../tasks/rows";
import type { BatchRecord, ExportExtra, PageFlagExtra, ProposalRecord } from "../tasks/types";
import type { Env } from "./env";
import { HttpError } from "./http";
import { proposalView } from "./queue";

/** A served line stays leased to its volunteer this long; leased slots are not offered to others meanwhile. */
export const LINE_LEASE_MS = 10 * 60 * 1000;
const PREFETCH = 3;
/** The maintainer's queue: lines with no majority, and lines with no box. */
const MAINTAINER_STATES = "('to_maintainer', 'no_box')";

/** Volunteer line batches: line review (line_consensus) and handwriting transcription (line_transcribe). */
export const isConsensus = (batch: BatchRecord) => batch.taskType === LINE_CONSENSUS || batch.taskType === LINE_TRANSCRIBE;
/**
 * Handwriting transcription: no gold of its own. Anyone may transcribe; whose decisions count is the reviewer's
 * standing in its gate batch (the mid-century volunteer batch), less this batch's own admin exclusions. A line goes
 * on being offered until counted decisions settle it, as in line review.
 */
export const isTranscribe = (batch: BatchRecord) => batch.taskType === LINE_TRANSCRIBE;

/**
 * Volunteer line review runs only where it is switched on (CONSENSUS_ENABLED=1: preview), until the maintainer has
 * approved the privacy text for gold lines and accuracy.
 */
export function assertConsensusEnabled(env: Env): void {
  if (env.CONSENSUS_ENABLED !== "1") throw new HttpError(404, "not_found");
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The reviewer's gold seed in [0, 1): the first 32 bits of sha256("gold|" + reviewer_id). */
export function goldOffset(reviewerId: string): number {
  return parseInt(sha256Hex(`gold|${reviewerId}`).slice(0, 8), 16) / 2 ** 32;
}

/** The order in which a reviewer meets the gold lines: by sha256("gold|" + reviewer_id + "|" + gold_id). */
export function goldOrder(reviewerId: string, goldIds: string[]): string[] {
  return goldIds
    .map((g) => [sha256Hex(`gold|${reviewerId}|${g}`), g] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, g]) => g);
}

async function proposalsByIds(db: D1Database, ids: number[]): Promise<ProposalRecord[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id WHERE p.id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(ids))
    .all<ProposalRow>();
  return results.map(toProposal);
}

async function goldProposals(db: D1Database, batchId: string): Promise<ProposalRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id
       WHERE p.batch_id = ?1 AND p.active = 1 AND json_extract(p.payload_json, '$.gold') IS NOT NULL`,
    )
    .bind(batchId)
    .all<ProposalRow>();
  return results.map(toProposal);
}

/** Standings of the given reviewers (all reviewers when `ids` is null) in a batch. */
export async function standings(db: D1Database, batchId: string, ids: string[] | null): Promise<Map<string, StandingRow>> {
  const gold = new Map((await goldProposals(db, batchId)).map((p) => [p.id, p]));
  const filter = ids ? "AND d.reviewer_id IN (SELECT value FROM json_each(?2))" : "";
  const [decided, excl] = await db.batch([
    db
      .prepare(
        `SELECT d.reviewer_id, d.value, d.text, d.proposal_id FROM decisions d JOIN proposals p ON p.id = d.proposal_id
         WHERE p.batch_id = ?1 AND d.superseded_at IS NULL AND json_extract(p.payload_json, '$.gold') IS NOT NULL ${filter}`,
      )
      .bind(...(ids ? [batchId, JSON.stringify(ids)] : [batchId])),
    db.prepare(`SELECT reviewer_id FROM agreement_exclusions WHERE batch_id = ?1`).bind(batchId),
  ]);
  const rows = (decided!.results ?? []) as { reviewer_id: string; value: string; text: string | null; proposal_id: number }[];
  const excluded = new Set(((excl!.results ?? []) as { reviewer_id: string }[]).map((r) => r.reviewer_id).filter((r) => !ids || ids.includes(r)));
  return standingsOf(
    rows.flatMap((r) => (gold.has(r.proposal_id) ? [{ reviewerId: r.reviewer_id, value: r.value, text: r.text, proposal: gold.get(r.proposal_id)! }] : [])),
    excluded,
  );
}

/** The standings that route this batch's lines: its own (line review), or the gate batch's (transcription). */
export async function routingStandings(db: D1Database, batch: BatchRecord, ids: string[] | null): Promise<Map<string, StandingRow>> {
  if (!isTranscribe(batch)) return standings(db, batch.id, ids);
  const st = await standings(db, gateBatchOf(batch), ids);
  const { results } = await db.prepare("SELECT reviewer_id FROM agreement_exclusions WHERE batch_id = ?1").bind(batch.id).all<{ reviewer_id: string }>();
  for (const { reviewer_id } of results) {
    if (ids && !ids.includes(reviewer_id)) continue;
    st.set(reviewer_id, { ...standingOf(st, reviewer_id), state: "excluded" });
  }
  return st;
}

/** The transcription batches gated on this batch: a standing change here changes who counts there. */
async function dependents(db: D1Database, gateBatchId: string): Promise<BatchRecord[]> {
  const { results } = await db.prepare(`${BATCH_SQL} WHERE task_type = ?1`).bind(LINE_TRANSCRIBE).all<BatchRow>();
  return results.map(toBatch).filter((b) => gateBatchOf(b) === gateBatchId);
}

async function recomputeDependents(db: D1Database, gateBatchId: string, reviewerId: string, nowMs: number): Promise<void> {
  for (const b of await dependents(db, gateBatchId)) await recomputeReviewer(db, b, reviewerId, nowMs);
}

/** Recompute and store the state of these lines (gold lines have none). */
export async function recomputeLines(db: D1Database, batch: BatchRecord, ids: number[], nowMs: number): Promise<void> {
  const lines = (await proposalsByIds(db, ids)).filter((p) => p.batchId === batch.id && !isGold(p));
  if (!lines.length) return;
  const { results } = await db
    .prepare(
      `SELECT d.id, d.proposal_id, d.reviewer_id, d.value, d.text, d.created_at, (m.decision_id IS NOT NULL) AS maintainer
       FROM decisions d LEFT JOIN maintainer_decisions m ON m.decision_id = d.id
       JOIN proposals p ON p.id = d.proposal_id
       WHERE d.proposal_id IN (SELECT value FROM json_each(?1)) AND d.superseded_at IS NULL AND d.proposal_sha256 = p.content_sha256`,
    )
    .bind(JSON.stringify(lines.map((p) => p.id)))
    .all<{ id: string; proposal_id: number; reviewer_id: string; value: string; text: string | null; created_at: string; maintainer: number }>();
  const reviewers = [...new Set(results.filter((r) => !r.maintainer).map((r) => r.reviewer_id))];
  const st = await routingStandings(db, batch, reviewers);
  const now = iso(nowMs);
  const stmts = lines.map((p) => {
    const ds = results.filter((r) => r.proposal_id === p.id);
    const vol = ds
      .filter((r) => !r.maintainer)
      .map((r) => ({ reviewerId: r.reviewer_id, value: r.value, text: r.text, at: r.created_at }))
      .map((v) => (isTranscribe(batch) ? forAgreement(v) : v));
    const routed = routeLine(p, vol, ds.some((r) => r.maintainer), st);
    return db
      .prepare(
        `INSERT INTO line_state (proposal_id, batch_id, state, needed, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (proposal_id) DO UPDATE SET state = excluded.state, needed = excluded.needed, updated_at = excluded.updated_at`,
      )
      .bind(p.id, batch.id, routed.state, routed.needed, now);
  });
  for (let k = 0; k < stmts.length; k += 200) await db.batch(stmts.slice(k, k + 200));
}

/** Recompute every line this reviewer decided in the batch (their standing changed). */
export async function recomputeReviewer(db: D1Database, batch: BatchRecord, reviewerId: string, nowMs: number): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT d.proposal_id FROM decisions d JOIN proposals p ON p.id = d.proposal_id
       WHERE p.batch_id = ?1 AND d.reviewer_id = ?2 AND d.superseded_at IS NULL AND json_extract(p.payload_json, '$.gold') IS NULL`,
    )
    .bind(batch.id, reviewerId)
    .all<{ proposal_id: number }>();
  const ids = results.map((r) => r.proposal_id);
  for (let k = 0; k < ids.length; k += 500) await recomputeLines(db, batch, ids.slice(k, k + 500), nowMs);
}

/** A volunteer's progress: their own counts only (nothing about other volunteers' work). */
export async function consensusProgress(db: D1Database, batch: BatchRecord, reviewerId: string, more: boolean): Promise<Progress> {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM decisions d JOIN proposals p ON p.id = d.proposal_id WHERE p.batch_id = ?1 AND d.reviewer_id = ?2 AND d.superseded_at IS NULL) AS mine,
        (SELECT COUNT(*) FROM skips s JOIN proposals p ON p.id = s.proposal_id WHERE p.batch_id = ?1 AND s.reviewer_id = ?2) AS skipped`,
    )
    .bind(batch.id, reviewerId)
    .first<{ mine: number; skipped: number }>();
  return { total: 0, covered: 0, minReviewers: 2, decidedByMe: row?.mine ?? 0, skippedByMe: row?.skipped ?? 0, remainingForMe: more ? 1 : 0, ownOnly: true };
}

const LINE_OPEN_SQL = `SELECT ${PROPOSAL_COLUMNS} FROM line_state s JOIN proposals p ON p.id = s.proposal_id JOIN items i ON i.id = p.item_id
  WHERE s.batch_id = ?1 AND s.state = 'open' AND p.active = 1
    AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2)
    AND NOT EXISTS (SELECT 1 FROM skips k WHERE k.proposal_id = p.id AND k.reviewer_id = ?2)
    AND (COALESCE(json_extract(p.payload_json, '$.stratum'), '') <> 'other_hebrew_script'
      OR NOT EXISTS (SELECT 1 FROM json_each(p.payload_json, '$.languages') l WHERE l.value <> 'he' AND l.value NOT IN (SELECT value FROM json_each(?5))))
    AND s.needed > (SELECT COUNT(*) FROM assignments a WHERE a.proposal_id = p.id AND a.reviewer_id <> ?2 AND a.assigned_at > ?3
      AND NOT EXISTS (SELECT 1 FROM decisions e WHERE e.proposal_id = a.proposal_id AND e.reviewer_id = a.reviewer_id))
  ORDER BY s.needed, p.rank
  LIMIT ?4`;

const MAINTAINER_SQL = `SELECT ${PROPOSAL_COLUMNS} FROM line_state s JOIN proposals p ON p.id = s.proposal_id JOIN items i ON i.id = p.item_id
  WHERE s.batch_id = ?1 AND s.state IN ${MAINTAINER_STATES} AND p.active = 1
    AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2)
    AND NOT EXISTS (SELECT 1 FROM skips k WHERE k.proposal_id = p.id AND k.reviewer_id = ?2)
  ORDER BY p.rank
  LIMIT ?3`;

/** The gold line due for this reviewer now, if any (each at most once; none once the pool is used up). */
async function dueGold(db: D1Database, batch: BatchRecord, reviewerId: string): Promise<ProposalRecord | null> {
  const counts = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN json_extract(p.payload_json, '$.gold') IS NULL THEN 1 ELSE 0 END) AS lines,
        SUM(CASE WHEN json_extract(p.payload_json, '$.gold') IS NOT NULL THEN 1 ELSE 0 END) AS gold
       FROM decisions d JOIN proposals p ON p.id = d.proposal_id WHERE p.batch_id = ?1 AND d.reviewer_id = ?2`,
    )
    .bind(batch.id, reviewerId)
    .first<{ lines: number | null; gold: number | null }>();
  if (!goldNext(counts?.lines ?? 0, counts?.gold ?? 0, goldOffset(reviewerId))) return null;
  const pool = await goldProposals(db, batch.id);
  if (!pool.length) return null;
  const { results } = await db
    .prepare(
      `SELECT proposal_id FROM decisions WHERE reviewer_id = ?2 AND proposal_id IN (SELECT id FROM proposals WHERE batch_id = ?1)
       UNION SELECT proposal_id FROM skips WHERE reviewer_id = ?2 AND proposal_id IN (SELECT id FROM proposals WHERE batch_id = ?1)`,
    )
    .bind(batch.id, reviewerId)
    .all<{ proposal_id: number }>();
  const done = new Set(results.map((r) => r.proposal_id));
  const byGold = new Map(pool.filter((p) => !done.has(p.id)).map((p) => [payloadOf(p).gold!.gold_id, p]));
  const first = goldOrder(reviewerId, [...byGold.keys()])[0];
  return first ? byGold.get(first)! : null;
}

/**
 * The next line for this reviewer. `languages`: the languages besides Hebrew the volunteer said, for this session,
 * that they read; other_hebrew_script lines are served only when all of theirs are among them. Nothing about it is
 * stored.
 */
export async function nextLine(db: D1Database, batch: BatchRecord, reviewerId: string, admin: boolean, nowMs: number, languages: string[] = []): Promise<NextResponse> {
  let rows: ProposalRecord[];
  if (admin) {
    rows = (await db.prepare(MAINTAINER_SQL).bind(batch.id, reviewerId, 1 + PREFETCH).all<ProposalRow>()).results.map(toProposal);
  } else {
    const gold = isTranscribe(batch) ? null : await dueGold(db, batch, reviewerId);
    const open = (await db.prepare(LINE_OPEN_SQL).bind(batch.id, reviewerId, nowMs - LINE_LEASE_MS, 1 + PREFETCH, JSON.stringify(languages)).all<ProposalRow>()).results.map(toProposal);
    rows = gold ? [gold, ...open] : open;
  }
  const first = rows[0];
  const progress = await consensusProgress(db, batch, reviewerId, first !== undefined);
  if (!first) return { proposal: null, progress, prefetch: [] };
  await db
    .prepare(
      `INSERT INTO assignments (proposal_id, reviewer_id, assigned_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (proposal_id, reviewer_id) DO UPDATE SET assigned_at = excluded.assigned_at`,
    )
    .bind(first.id, reviewerId, nowMs)
    .run();
  const prefetch = rows
    .slice(1)
    .flatMap((r) => (r.media.page ? [imageUrl(r.media.page.ref)] : []));
  return { proposal: await proposalView(db, batch, first, reviewerId), progress, prefetch: [...new Set(prefetch)] };
}

/**
 * Whether a reviewer may see or decide this line: a volunteer only a line this queue served them (or one they
 * decided); the maintainer only a line that went to them (or one they decided).
 */
export async function lineOpenTo(db: D1Database, p: ProposalRecord, reviewerId: string, admin: boolean): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT
        EXISTS (SELECT 1 FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2) AS decided,
        EXISTS (SELECT 1 FROM assignments WHERE proposal_id = ?1 AND reviewer_id = ?2) AS served,
        (SELECT state FROM line_state WHERE proposal_id = ?1) AS state`,
    )
    .bind(p.id, reviewerId)
    .first<{ decided: number; served: number; state: string | null }>();
  if (!row) return false;
  if (row.decided) return true;
  if (admin) return !isGold(p) && (row.state === "to_maintainer" || row.state === "no_box");
  return row.served === 1 && (isGold(p) || hasBox(p));
}

/** After a decision on a line: record a maintainer's as such, and recompute what it changes. */
export async function afterLineDecision(db: D1Database, batch: BatchRecord, p: ProposalRecord, decisionId: string, reviewerId: string, admin: boolean, nowMs: number): Promise<void> {
  if (admin) {
    await db.prepare("INSERT OR IGNORE INTO maintainer_decisions (decision_id) VALUES (?1)").bind(decisionId).run();
    await recomputeLines(db, batch, [p.id], nowMs);
    return;
  }
  if (!isGold(p)) {
    await recomputeLines(db, batch, [p.id], nowMs);
    return;
  }
  // A gold answer can move the volunteer across the floor or past their 20th gold line: then every line they
  // decided may change.
  const after = standingOf(await standings(db, batch.id, [reviewerId]), reviewerId);
  const { results } = await db
    .prepare(
      `SELECT d.value, d.text, d.proposal_id FROM decisions d JOIN proposals p ON p.id = d.proposal_id
       WHERE p.batch_id = ?1 AND d.reviewer_id = ?2 AND d.superseded_at IS NULL AND d.id <> ?3 AND json_extract(p.payload_json, '$.gold') IS NOT NULL`,
    )
    .bind(batch.id, reviewerId, decisionId)
    .all<{ value: string; text: string | null; proposal_id: number }>();
  const gold = new Map((await goldProposals(db, batch.id)).map((g) => [g.id, g]));
  const excluded = after.state === "excluded" ? new Set([reviewerId]) : new Set<string>();
  const before = standingOf(
    standingsOf(results.flatMap((r) => (gold.has(r.proposal_id) ? [{ reviewerId, value: r.value, text: r.text, proposal: gold.get(r.proposal_id)! }] : [])), excluded),
    reviewerId,
  );
  if (before.state !== after.state) {
    await recomputeReviewer(db, batch, reviewerId, nowMs);
    await recomputeDependents(db, batch.id, reviewerId, nowMs);
  }
}

/** The admin's view of a volunteer batch: line states, and per volunteer their gold record and standing. */
export async function volunteerReport(db: D1Database, batch: BatchRecord) {
  const [states, decided, excl] = await db.batch([
    db.prepare("SELECT state, COUNT(*) AS n FROM line_state WHERE batch_id = ?1 GROUP BY state").bind(batch.id),
    db
      .prepare(
        `SELECT d.reviewer_id, COUNT(*) AS n FROM decisions d JOIN proposals p ON p.id = d.proposal_id
         LEFT JOIN maintainer_decisions m ON m.decision_id = d.id
         WHERE p.batch_id = ?1 AND d.superseded_at IS NULL AND m.decision_id IS NULL AND json_extract(p.payload_json, '$.gold') IS NULL
         GROUP BY d.reviewer_id`,
      )
      .bind(batch.id),
    db.prepare("SELECT reviewer_id, excluded_at FROM agreement_exclusions WHERE batch_id = ?1").bind(batch.id),
  ]);
  const lines = new Map(((decided!.results ?? []) as { reviewer_id: string; n: number }[]).map((r) => [r.reviewer_id, r.n]));
  const excludedAt = new Map(((excl!.results ?? []) as { reviewer_id: string; excluded_at: string }[]).map((r) => [r.reviewer_id, r.excluded_at]));
  // Transcription: only reviewers who worked in this batch (or are excluded from it), with their gate standing.
  const st = isTranscribe(batch) ? await routingStandings(db, batch, [...new Set([...lines.keys(), ...excludedAt.keys()])]) : await standings(db, batch.id, null);
  const ids = [...new Set([...lines.keys(), ...st.keys()])].sort();
  return {
    states: Object.fromEntries(((states!.results ?? []) as { state: string; n: number }[]).map((r) => [r.state, r.n])),
    volunteers: ids.map((id) => {
      const s = standingOf(st, id);
      return {
        id,
        lines: lines.get(id) ?? 0,
        goldSeen: s.graded,
        goldHits: s.hits,
        accuracy: s.accuracy,
        plantedSeen: s.plantedSeen,
        plantedHits: s.plantedHits,
        standing: s.state,
        excludedAt: excludedAt.get(id) ?? null,
      };
    }),
  };
}

/** The admin's switch: exclude a reviewer from agreement in a batch (or include them again), then recompute. */
export async function setExclusion(db: D1Database, batch: BatchRecord, reviewerId: string, excluded: boolean, nowMs: number): Promise<void> {
  if (excluded) {
    await db
      .prepare("INSERT OR IGNORE INTO agreement_exclusions (batch_id, reviewer_id, excluded_at) VALUES (?1, ?2, ?3)")
      .bind(batch.id, reviewerId, iso(nowMs))
      .run();
  } else {
    await db.prepare("DELETE FROM agreement_exclusions WHERE batch_id = ?1 AND reviewer_id = ?2").bind(batch.id, reviewerId).run();
  }
  await recomputeReviewer(db, batch, reviewerId, nowMs);
  if (!isTranscribe(batch)) await recomputeDependents(db, batch.id, reviewerId, nowMs);
}

/** The export's extra inputs: exclusions, the maintainer's decisions and (transcription) the gate standings. */
export async function exportExtras(db: D1Database, batch: BatchRecord): Promise<Omit<ExportExtra, "exportedAt">> {
  const batchId = batch.id;
  const [excl, maint] = await db.batch([
    db.prepare(CONSENSUS_EXPORT_SQL.exclusions).bind(batchId),
    db.prepare(CONSENSUS_EXPORT_SQL.maintainer).bind(batchId),
  ]);
  let gate: Record<string, string> | undefined;
  if (isTranscribe(batch)) {
    const { results } = await db
      .prepare("SELECT DISTINCT d.reviewer_id FROM decisions d JOIN proposals p ON p.id = d.proposal_id WHERE p.batch_id = ?1")
      .bind(batchId)
      .all<{ reviewer_id: string }>();
    const st = await standings(db, gateBatchOf(batch), results.map((r) => r.reviewer_id));
    gate = Object.fromEntries(results.map((r) => [r.reviewer_id, standingOf(st, r.reviewer_id).state]));
  }
  let pageFlags: PageFlagExtra[] | undefined;
  if (isTranscribe(batch)) {
    const [f, a] = await db.batch([db.prepare(CONSENSUS_EXPORT_SQL.pageFlags).bind(batchId), db.prepare(CONSENSUS_EXPORT_SQL.pageFlagAnswers).bind(batchId)]);
    pageFlags = pageFlagsOf((f!.results ?? []) as PageFlagRow[], (a!.results ?? []) as PageFlagAnswerRow[]);
  }
  return {
    ...(gate ? { standings: gate } : {}),
    ...(pageFlags ? { pageFlags } : {}),
    exclusions: ((excl!.results ?? []) as { reviewer_id: string; excluded_at: string }[]).map((r) => ({ reviewerId: r.reviewer_id, excludedAt: r.excluded_at })),
    maintainerDecisions: ((maint!.results ?? []) as { decision_id: string }[]).map((r) => r.decision_id),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Page flags (line_transcribe): "text outside the boxes"

/**
 * A volunteer's report that the page of a line they were served has a text line no box covers. One per volunteer
 * per page; it decides nothing about the line they are on.
 */
export async function reportPageFlag(db: D1Database, p: ProposalRecord, reviewerId: string, kind: string, nowMs: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO page_flags (item_id, reviewer_id, kind, created_at) SELECT item_id, ?2, ?3, ?4 FROM proposals WHERE id = ?1")
    .bind(p.id, reviewerId, kind, iso(nowMs))
    .run();
}

export interface FlaggedPage {
  itemId: number;
  pageKey: string;
  kind: string;
  reports: number;
  firstReportedAt: string;
  answer: "confirmed" | "dismissed" | null;
  /** The page image, with the boxes as imported (for the maintainer's look). */
  page: { url: string; width: number; height: number } | null;
  boxes: [number, number, number, number][];
}

/** The maintainer's queue of reported pages, unanswered first. */
export async function flaggedPages(db: D1Database, batch: BatchRecord): Promise<FlaggedPage[]> {
  const { results } = await db
    .prepare(
      `SELECT f.item_id, i.external_id AS page_key, f.kind, COUNT(*) AS reports, MIN(f.created_at) AS first_at, a.answer
       FROM page_flags f JOIN items i ON i.id = f.item_id
       LEFT JOIN page_flag_answers a ON a.item_id = f.item_id AND a.kind = f.kind
       WHERE i.batch_id = ?1 GROUP BY f.item_id, f.kind ORDER BY (a.answer IS NOT NULL), first_at`,
    )
    .bind(batch.id)
    .all<{ item_id: number; page_key: string; kind: string; reports: number; first_at: string; answer: "confirmed" | "dismissed" | null }>();
  const out: FlaggedPage[] = [];
  for (const r of results) {
    const { results: ps } = await db
      .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id WHERE p.item_id = ?1 AND p.active = 1 ORDER BY p.rank`)
      .bind(r.item_id)
      .all<ProposalRow>();
    const lines = ps.map(toProposal);
    const img = lines[0]?.media.page;
    out.push({
      itemId: r.item_id,
      pageKey: r.page_key,
      kind: r.kind,
      reports: r.reports,
      firstReportedAt: r.first_at,
      answer: r.answer,
      page: img ? { url: imageUrl(img.ref), width: img.width, height: img.height } : null,
      boxes: lines.map((l) => payloadOf(l).page_box as [number, number, number, number]),
    });
  }
  return out;
}

/** The maintainer's answer on a reported page: confirmed (re-box it) or dismissed; null withdraws the answer. */
export async function answerPageFlag(db: D1Database, batch: BatchRecord, itemId: number, kind: string, answer: "confirmed" | "dismissed" | null, adminId: string, nowMs: number): Promise<boolean> {
  const item = await db
    .prepare("SELECT 1 AS ok FROM page_flags f JOIN items i ON i.id = f.item_id WHERE f.item_id = ?1 AND f.kind = ?2 AND i.batch_id = ?3 LIMIT 1")
    .bind(itemId, kind, batch.id)
    .first<{ ok: number }>();
  if (!item) return false;
  if (answer === null) await db.prepare("DELETE FROM page_flag_answers WHERE item_id = ?1 AND kind = ?2").bind(itemId, kind).run();
  else {
    await db
      .prepare(
        `INSERT INTO page_flag_answers (item_id, kind, answer, reviewer_id, answered_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (item_id, kind) DO UPDATE SET answer = excluded.answer, reviewer_id = excluded.reviewer_id, answered_at = excluded.answered_at`,
      )
      .bind(itemId, kind, answer, adminId, iso(nowMs))
      .run();
  }
  return true;
}
