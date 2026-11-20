/** Which proposal a reviewer sees next, and progress counts. */
import type { NextResponse, PageDraft, PageDraftRow, Progress, ProposalView } from "../shared/api";
import { imageUrl } from "../shared/media";
import { pageCounts } from "./pages";
import { sha256Hex } from "../shared/sha256";
import { TASK_TYPE_ID as PAGE_REVIEW, payloadOf } from "../tasks/page_review";
import { PROPOSAL_COLUMNS, toProposal, type ProposalRow } from "../tasks/rows";
import { taskType } from "../tasks/registry";
import type { BatchRecord, ProposalRecord } from "../tasks/types";
import { assignReserves, type ReserveRow } from "./reserves";
import { servedMembers, type CurrentDecisionRow, type SubsetMemberRow } from "./subsets";
import { NOT_GOLD, dueGold, isVolunteerV11 } from "./phist_gold";
import { VOLUNTEER_DONE, isVolunteerV1, volunteerOpen } from "./verify_resolution";
import { CONTENT_MATCH_SQL, PENDING_SQL, TRIAGEABLE_SQL, candidateOf, isTriageBatch, triageable } from "../tasks/line_verify/triage";

/** How long a served proposal stays leased to its reviewer before others are offered it first. */
export const LEASE_MS = 10 * 60 * 1000;
const PREFETCH = 3;
/** A blind second pass opens this long after the reviewer's first decision on the paired first-pass page. */
export const BLIND_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * The pass-1 answers that open a blind second pass ('after_confirm'): a page_review confirm, or a line_verify answer
 * that gives the line's text (exact, edited, pointed_print, or typed on a typed line; in triage, correct or
 * niqqud_mismatch: migrations/0012_triage.sql). A line marked unreadable,
 * misaligned (without a typed text: v1 and v1.1 lines) or with a box problem gets no pass 2; a v1.2 misaligned line,
 * typed, does.
 */
const SETTLED = "('confirm', 'exact', 'edited', 'pointed_print', 'typed', 'correct', 'niqqud_mismatch')";

/**
 * Who a batch's blind second pass goes to (migrations/0006_batch_settings.sql): 'same', the reviewer who answered pass
 * 1, 24 hours later; or 'other' (line_verify only), a reviewer who never decided the line's pass 1, 24 hours after
 * another reviewer's answer.
 */
/**
 * How many current decisions proposal p needs (in place of the batch's min_reviewers ?n): two on a line_verify typed
 * line's pass 1 when its page's book group is in the batch's two_typings_groups (migrations/0007_two_typings.sql).
 */
const needed = (n: number) => `MAX(?${n}, CASE WHEN json_extract(p.payload_json, '$.kind') = 'type'
    AND COALESCE(json_extract(p.payload_json, '$.pass'), 1) = 1
    AND EXISTS (SELECT 1 FROM batch_settings s, json_each(s.two_typings_groups) g
      WHERE s.batch_id = p.batch_id AND g.value = json_extract(p.payload_json, '$.page.book_group'))
    THEN 2 ELSE 1 END)`;

const PASS2_MODE = "COALESCE((SELECT s.pass2_reviewer FROM batch_settings s WHERE s.batch_id = p.batch_id), 'same')";

/**
 * Whether proposal p is open to reviewer ?2 under its gate (migrations/0002_proposal_gates.sql; a blind second pass
 * also by the batch's pass2_reviewer setting, 0006). `reserves` binds a
 * JSON array of the reserve proposal ids assigned so far, `cutoff` the ISO time before which a first-pass decision
 * must have been made.
 */
function eligible(reserves: number, cutoff: number): string {
  return `(p.gate_kind IS NULL
    OR (p.gate_kind = 'reserve' AND p.id IN (SELECT value FROM json_each(?${reserves})))
    OR (p.gate_kind = 'after_confirm' AND ${PASS2_MODE} = 'same'
      AND EXISTS (SELECT 1 FROM proposals q JOIN decisions d ON d.proposal_id = q.id
        WHERE q.batch_id = p.batch_id AND q.external_id = p.gate_ref AND q.active = 1 AND d.reviewer_id = ?2
          AND d.superseded_at IS NULL AND ((d.value IN ${SETTLED} AND NOT ${PENDING_SQL("d")}) OR (d.value = 'misaligned' AND d.text IS NOT NULL)) AND d.proposal_sha256 = q.content_sha256)
      AND (SELECT MIN(d.created_at) FROM proposals q JOIN decisions d ON d.proposal_id = q.id
        WHERE q.batch_id = p.batch_id AND q.external_id = p.gate_ref AND d.reviewer_id = ?2) <= ?${cutoff})
    OR (p.gate_kind = 'after_confirm' AND ${PASS2_MODE} = 'other'
      AND NOT EXISTS (SELECT 1 FROM proposals q JOIN decisions d ON d.proposal_id = q.id
        WHERE q.batch_id = p.batch_id AND q.external_id = p.gate_ref AND d.reviewer_id = ?2)
      AND EXISTS (SELECT 1 FROM proposals q JOIN decisions d ON d.proposal_id = q.id
        WHERE q.batch_id = p.batch_id AND q.external_id = p.gate_ref AND q.active = 1 AND d.reviewer_id <> ?2
          AND d.superseded_at IS NULL AND ((d.value IN ${SETTLED} AND NOT ${PENDING_SQL("d")}) OR (d.value = 'misaligned' AND d.text IS NOT NULL)) AND d.proposal_sha256 = q.content_sha256
          AND (SELECT MIN(e.created_at) FROM decisions e WHERE e.proposal_id = q.id AND e.reviewer_id = d.reviewer_id) <= ?${cutoff})))`;
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

/** A subset chosen as a filter on the queue: the proposals its strata serve now, and how many strata it has. */
export interface SubsetFilter {
  id: string;
  ids: number[];
  strata: number;
}

/**
 * A triage batch's two queues for a reviewer (migrations/0012_triage.sql) as filters: "triage", the lines with a
 * candidate they have not called different; "fix" (the desktop), their "different" lines and every line without a
 * candidate (typed lines without a draft, and the blind second pass). A "different" answer leaves a line open to the
 * reviewer (openSql), so the fix queue serves it; the fix supersedes it.
 */
export const TRIAGE_QUEUES = ["triage", "fix"] as const;
export type TriageQueue = (typeof TRIAGE_QUEUES)[number];
export async function triageFilter(db: D1Database, batchId: string, reviewerId: string, queue: TriageQueue): Promise<SubsetFilter> {
  const mineDifferent = `EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2 AND d.superseded_at IS NULL AND ${CONTENT_MATCH_SQL} AND ${PENDING_SQL("d")})`;
  const where = queue === "triage" ? `${TRIAGEABLE_SQL} AND NOT ${mineDifferent}` : `(NOT ${TRIAGEABLE_SQL} OR ${mineDifferent})`;
  const { results } = await db
    .prepare(`SELECT p.id FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND ${where}`)
    .bind(batchId, reviewerId)
    .all<{ id: number }>();
  const ids = results.map((r) => r.id);
  return { id: `queue:${queue}`, ids, strata: ids.length };
}

/** A batch's subset as a queue filter (migrations/0003_subsets.sql), or null when the batch has no such subset. */
export async function loadSubset(db: D1Database, batchId: string, subsetId: string): Promise<SubsetFilter | null> {
  const exists = await db.prepare("SELECT 1 AS ok FROM subsets WHERE batch_id = ?1 AND id = ?2").bind(batchId, subsetId).first<{ ok: number }>();
  if (!exists) return null;
  const [members, decisions] = await db.batch([
    db
      .prepare(
        `SELECT m.stratum, m.position, p.id AS proposal_id, p.active FROM subset_members m
         LEFT JOIN proposals p ON p.batch_id = m.batch_id AND p.external_id = m.external_id
         WHERE m.batch_id = ?1 AND m.subset_id = ?2`,
      )
      .bind(batchId, subsetId),
    db
      .prepare(
        `SELECT d.proposal_id, d.value, d.text FROM decisions d JOIN proposals p ON p.id = d.proposal_id
         JOIN subset_members m ON m.batch_id = p.batch_id AND m.external_id = p.external_id
         WHERE m.batch_id = ?1 AND m.subset_id = ?2 AND d.superseded_at IS NULL`,
      )
      .bind(batchId, subsetId),
  ]);
  const served = servedMembers((members!.results ?? []) as SubsetMemberRow[], (decisions!.results ?? []) as CurrentDecisionRow[]);
  return { id: subsetId, ...served };
}

/** The subsets of a batch, for the app's filter: id, title and number of strata. */
export async function subsetsOf(db: D1Database, batchId: string): Promise<{ id: string; title: string; size: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.title, (SELECT COUNT(DISTINCT m.stratum) FROM subset_members m WHERE m.batch_id = s.batch_id AND m.subset_id = s.id) AS size
       FROM subsets s WHERE s.batch_id = ?1 ORDER BY s.id`,
    )
    .bind(batchId)
    .all<{ id: string; title: string; size: number }>();
  return results;
}

/**
 * SQL: proposal p's page is a volunteer page: an item of a volunteer line batch (line_consensus) with an active line
 * that is not gold. The maintainer's page-review queue leaves those pages out unless a filter names them (the
 * blind audit), so his references and the volunteers' never cover the same page (heocr-lead, 2026-11-18). The
 * interim pages, which give the volunteers' gold lines, stay his.
 */
const VOLUNTEER_PAGE = `EXISTS (SELECT 1 FROM items vi JOIN batches vb ON vb.id = vi.batch_id JOIN proposals vp ON vp.item_id = vi.id
    WHERE vb.task_type = 'line_consensus' AND vi.external_id = (SELECT external_id FROM items WHERE id = p.item_id)
      AND vp.active = 1 AND json_extract(vp.payload_json, '$.gold') IS NULL)`;

/**
 * SQL: proposal p is in the filter bound at ?n (a JSON array of ids); with no filter (null), any proposal, except that
 * a page_review batch (`volunteerPages`) leaves out volunteer pages. Only page_review shares page keys with the
 * volunteer batch; running the volunteer lookup for every other batch's every proposal overloaded preview's D1
 * (2026-11-18), so the other task types never run it.
 */
const inFilter = (n: number, volunteerPages: boolean) =>
  volunteerPages
    ? `(CASE WHEN ?${n} IS NULL THEN NOT ${VOLUNTEER_PAGE} ELSE p.id IN (SELECT value FROM json_each(?${n})) END)`
    : `(?${n} IS NULL OR p.id IN (SELECT value FROM json_each(?${n})))`;

/**
 * Open to reviewer ?2: active, not decided by them, not skipped by them, and below the batch's reviewer target.
 * Proposals leased to someone else in the last LEASE_MS come after the rest; then by rank (the
 * task type's serving order, set at import).
 */
/**
 * SQL: proposal p still wants a decision from reviewer ?2 (who has not decided it): below the reviewer target, or for
 * a volunteer_v1 batch (`volunteer`: the reviewer is the admin or not), its routing step lets them decide it.
 */
const settledDecision = (triageBatch: boolean) =>
  `d.superseded_at IS NULL AND NOT ${PENDING_SQL("d")}${triageBatch ? ` AND ${CONTENT_MATCH_SQL}` : ""}`;

const wantsDecision = (volunteer: { admin: boolean } | null, settled: string) =>
  volunteer
    ? `${volunteerOpen(volunteer.admin)} AND ${NOT_GOLD}`
    : `(SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND ${settled}) < ${needed(3)}`;

const openSql = (volunteerPages: boolean, volunteer: { admin: boolean } | null, settled: string) => `SELECT ${PROPOSAL_COLUMNS} FROM proposals p JOIN items i ON i.id = p.item_id
  WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(6, 7)} AND ${inFilter(8, volunteerPages)}
    AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2 AND ${settled})
    AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.proposal_id = p.id AND s.reviewer_id = ?2)
    AND ${wantsDecision(volunteer, settled)}
  ORDER BY EXISTS (SELECT 1 FROM assignments a WHERE a.proposal_id = p.id AND a.reviewer_id <> ?2 AND a.assigned_at > ?4),
    p.rank
  LIMIT ?5`;

/**
 * Progress over the proposals open to this reviewer now (gated ones count once they open). With a subset filter,
 * over the proposals its strata serve, and the total is its number of strata.
 */
export async function progressFor(
  db: D1Database,
  batch: BatchRecord,
  reviewerId: string,
  nowMs = Date.now(),
  filter: SubsetFilter | null = null,
  admin = false,
): Promise<Progress> {
  const [reserves, cutoff] = await gateParams(db, batch.id, nowMs);
  const f = inFilter(6, batch.taskType === PAGE_REVIEW);
  const volunteer = isVolunteerV1(batch) ? { admin } : null;
  // A volunteer_v1 line is covered once it is resolved or unresolved.
  // Gold lines (volunteer_v1_1) are never counted in progress: they are not the batch's lines.
  const g = volunteer ? ` AND ${NOT_GOLD}` : "";
  const settled = settledDecision(isTriageBatch(batch));
  const covered = volunteer
    ? VOLUNTEER_DONE
    : `(SELECT COUNT(*) FROM decisions d WHERE d.proposal_id = p.id AND ${settled}) >= ${needed(3)}`;
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(4, 5)} AND ${f}${g}) AS total,
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(4, 5)} AND ${f}${g} AND ${covered}) AS covered,
        (SELECT COUNT(*) FROM decisions d JOIN proposals p ON p.id = d.proposal_id
          WHERE p.batch_id = ?1 AND p.active = 1 AND ${f}${g} AND d.reviewer_id = ?2 AND d.superseded_at IS NULL) AS mine,
        (SELECT COUNT(*) FROM skips s JOIN proposals p ON p.id = s.proposal_id
          WHERE p.batch_id = ?1 AND p.active = 1 AND ${f} AND s.reviewer_id = ?2) AS skipped,
        (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = ?1 AND p.active = 1 AND ${eligible(4, 5)} AND ${f}
          AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2 AND ${settled})
          AND NOT EXISTS (SELECT 1 FROM skips s WHERE s.proposal_id = p.id AND s.reviewer_id = ?2)
          AND ${wantsDecision(volunteer, settled)}) AS remaining`,
    )
    .bind(batch.id, reviewerId, batch.minReviewers, reserves, cutoff, filter ? JSON.stringify(filter.ids) : null)
    .first<{ total: number; covered: number; mine: number; skipped: number; remaining: number }>();
  return {
    total: filter ? filter.strata : (row?.total ?? 0),
    covered: row?.covered ?? 0,
    minReviewers: batch.minReviewers,
    decidedByMe: row?.mine ?? 0,
    skippedByMe: row?.skipped ?? 0,
    remainingForMe: row?.remaining ?? 0,
  };
}

/**
 * A line as triage shows it (migrations/0012_triage.sql): its plant's text in place of the candidate when it has one,
 * and never the attention runs, for any line, so nothing on the screen tells a plant apart (eval's amendment 2).
 */
async function asTriaged(db: D1Database, batch: BatchRecord, p: ProposalRecord, view: ProposalView["view"]): Promise<ProposalView["view"]> {
  if (view.kind !== "line_verify" || !isTriageBatch(batch) || !triageable(p)) return view;
  const plant = await db
    .prepare("SELECT planted_text, candidate_sha256 FROM triage_plants WHERE batch_id = ?1 AND proposal_id = ?2")
    .bind(batch.id, p.id)
    .first<{ planted_text: string; candidate_sha256: string }>();
  const shown = plant && plant.candidate_sha256 === sha256Hex(candidateOf(p)) ? plant.planted_text : view.candidate;
  return { ...view, candidate: shown, runs: [] };
}

export async function proposalView(db: D1Database, batch: BatchRecord, p: ProposalRecord, reviewerId: string, triage = false): Promise<ProposalView> {
  const type = taskType(batch.taskType);
  if (!type) throw new Error(`unknown task type ${batch.taskType}`);
  const mine = await db
    .prepare("SELECT value, text, decided_on FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL AND (?3 IS NULL OR proposal_sha256 = ?3)")
    .bind(p.id, reviewerId, isTriageBatch(batch) ? p.contentSha256 : null)
    .first<{ value: string; text: string | null; decided_on: string }>();
  const draft = !mine && batch.taskType === PAGE_REVIEW ? await draftFor(db, p, reviewerId) : null;
  return {
    id: p.id,
    batchId: p.batchId,
    externalId: p.externalId,
    itemTitle: p.itemTitle,
    view: triage ? await asTriaged(db, batch, p, type.toView(p)) : type.toView(p),
    options: type.optionsFor?.(p) ?? type.options,
    mine: mine ? { value: mine.value, text: mine.text, decidedAt: mine.decided_on } : null,
    ...(batch.taskType === PAGE_REVIEW ? { draft } : {}),
  };
}

/** The reviewer's draft of a page, if it was made on the page's current pre-fill; one made on another is deleted. */
async function draftFor(db: D1Database, p: ProposalRecord, reviewerId: string): Promise<PageDraft | null> {
  const row = await db
    .prepare("SELECT prefill_sha256, body, updated_at FROM drafts WHERE reviewer_id = ?1 AND proposal_id = ?2")
    .bind(reviewerId, p.id)
    .first<{ prefill_sha256: string; body: string; updated_at: string }>();
  if (!row) return null;
  const sha = payloadOf(p).prefill_sha256;
  if (row.prefill_sha256 !== sha) {
    await db.prepare("DELETE FROM drafts WHERE reviewer_id = ?1 AND proposal_id = ?2").bind(reviewerId, p.id).run();
    return null;
  }
  const body = JSON.parse(row.body) as { readingOrder: boolean; rows: PageDraftRow[] };
  return { prefillSha256: sha, readingOrder: body.readingOrder, rows: body.rows, savedAt: row.updated_at };
}

export async function nextFor(
  db: D1Database,
  batch: BatchRecord,
  reviewerId: string,
  nowMs = Date.now(),
  filter: SubsetFilter | null = null,
  admin = false,
  triage = false,
): Promise<NextResponse> {
  const [reserves, cutoff] = await gateParams(db, batch.id, nowMs);
  const { results } = await db
    .prepare(openSql(batch.taskType === PAGE_REVIEW, isVolunteerV1(batch) ? { admin } : null, settledDecision(isTriageBatch(batch))))
    .bind(batch.id, reviewerId, batch.minReviewers, nowMs - LEASE_MS, 1 + PREFETCH, reserves, cutoff, filter ? JSON.stringify(filter.ids) : null)
    .all<ProposalRow>();
  const open = results.map(toProposal);
  // volunteer_v1_1: a gold line in place of the next line when the reviewer's schedule says so, while the batch still
  // has a line for them (docs/specs/line_verify_phist_gold_v1_1.md, "Placement").
  const gold = open.length && isVolunteerV11(batch) ? await dueGold(db, batch, reviewerId) : null;
  const rows = gold ? [gold, ...open] : open;
  const progress = await progressFor(db, batch, reviewerId, nowMs, filter, admin);
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
  return { proposal: await proposalView(db, batch, first, reviewerId, triage), progress, prefetch: [...new Set(prefetch)] };
}

/** How many lines each triage queue still holds for the reviewer (the app's two entries into a triage batch). */
export async function triageCounts(db: D1Database, batch: BatchRecord, reviewerId: string, nowMs = Date.now()): Promise<{ triage: number; fix: number } | null> {
  if (!isTriageBatch(batch)) return null;
  const [triage, fix] = await Promise.all(
    TRIAGE_QUEUES.map(async (q) => (await progressFor(db, batch, reviewerId, nowMs, await triageFilter(db, batch.id, reviewerId, q))).remainingForMe),
  );
  // Pages wait in the queues too (migrations/0014): a check in triage, missing lines on the desktop.
  const pages = await pageCounts(db, batch.id, reviewerId);
  return { triage: triage! + pages.check, fix: fix! + pages.add };
}
