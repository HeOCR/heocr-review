/**
 * The pointed-book rule (migrations/0011_pointed_books.sql): a Hebrew source is pointed or unpointed as a whole, so
 * when the admin, or a reviewer whose decisions count, marks a line "print has niqqud", every other undecided line of
 * that book leaves the batch. Gold lines are never taken out. Only D1 here.
 */
import { notCountedReason } from "../tasks/line_consensus/consensus";
import { standingOf } from "../tasks/line_consensus/index";
import { GATE_BATCH_ID } from "../tasks/line_verify/resolution";
import { POINTED_DROPS_SQL, toPointedDrop, type PointedDropRow } from "../tasks/rows";
import type { BatchRecord, PointedDrop, ProposalRecord } from "../tasks/types";
import { standings } from "./consensus";
import { isVolunteerV11, phistReasonFor } from "./phist_gold";

/** Whether this reviewer's mark may take a book out: the admin, or a reviewer who counts now. */
async function maySignal(db: D1Database, batch: BatchRecord, reviewerId: string, admin: boolean): Promise<boolean> {
  if (admin) return true;
  if (notCountedReason(standingOf(await standings(db, GATE_BATCH_ID, [reviewerId]), reviewerId).state) !== null) return false;
  return !isVolunteerV11(batch) || (await phistReasonFor(db, reviewerId)) === null;
}

/**
 * After a "print has niqqud" decision on a line_verify line: take the book's other undecided lines out of the batch
 * (unless the batch is set to 'keep'), and record each one. Returns how many lines left.
 */
export async function dropPointedBook(
  db: D1Database,
  batch: BatchRecord,
  proposal: ProposalRecord,
  decisionId: string,
  reviewerId: string,
  admin: boolean,
  nowIso: string,
): Promise<number> {
  if (batch.settings?.pointedBooks === "keep") return 0;
  const book = (proposal.payload as { page?: { book_id?: string } }).page?.book_id;
  if (!book || !(await maySignal(db, batch, reviewerId, admin))) return 0;
  const { results } = await db
    .prepare(
      `UPDATE proposals SET active = 0
       WHERE batch_id = ?1 AND active = 1 AND id <> ?2 AND json_extract(payload_json, '$.page.book_id') = ?3
         AND json_extract(payload_json, '$.gold') IS NULL
         AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = proposals.id AND d.superseded_at IS NULL)
       RETURNING id`,
    )
    .bind(batch.id, proposal.id, book)
    .all<{ id: number }>();
  if (results.length) {
    await db.batch(
      results.map((r) =>
        db
          .prepare("INSERT OR IGNORE INTO pointed_book_drops (batch_id, proposal_id, book_id, decision_id, dropped_at) VALUES (?1, ?2, ?3, ?4, ?5)")
          .bind(batch.id, r.id, book, decisionId, nowIso),
      ),
    );
  }
  return results.length;
}

/** The export's pointed-drop input for a batch: one row per triggering mark. */
export async function pointedDropsExtra(db: D1Database, batchId: string): Promise<{ pointedDrops: PointedDrop[] }> {
  const { results } = await db.prepare(POINTED_DROPS_SQL).bind(batchId).all<PointedDropRow>();
  return { pointedDrops: results.map(toPointedDrop) };
}
