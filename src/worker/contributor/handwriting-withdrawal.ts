import type { ContributorSplit } from "../../shared/contributor";
import type { Ctx } from "../api";
import { HttpError, json, readJson } from "../http";
import { gone, hash, invalid, quarantinePrefix, submissionBucket } from "./config";

const digest = /^[a-f0-9]{64}$/;
const noStore = { "cache-control": "private, no-store" };

/** Records an already published, byte-identical original. This route never publishes. */
export async function recordHandwritingPublication(ctx: Ctx) {
  const { contentSha256, releaseSha256 } = await readJson(ctx.request);
  if (typeof contentSha256 !== "string" || !digest.test(contentSha256) ||
      typeof releaseSha256 !== "string" || !digest.test(releaseSha256)) throw invalid();
  const db = ctx.env.DB;
  const result = await db.prepare(`INSERT INTO contributor_handwriting_publications
    (content_sha256,storage_key,release_sha256)
    SELECT content_sha256,storage_key,?1 FROM contributor_handwriting_release_candidates WHERE content_sha256=?2
    ON CONFLICT DO NOTHING`).bind(releaseSha256,contentSha256).run();
  if (result.meta.changes !== 1) {
    const recorded = await db.prepare("SELECT release_sha256 FROM contributor_handwriting_publications WHERE content_sha256=?")
      .bind(contentSha256).first<string>("release_sha256");
    if (recorded !== releaseSha256) throw new HttpError(409,"handwriting_publication_conflict");
  }
  return json({recorded:true},200,noStore);
}

const rosters = ["contributor_handwriting_roster", "contributor_family_staff_roster"] as const;
type Withdrawal = { writer_id: string; split: ContributorSplit; live: number };

export async function purgeHandwritingEnrolment(ctx: Ctx, receipt: string) {
  const db = ctx.env.DB;
  const receiptHash = await hash(receipt);
  let table: typeof rosters[number] = rosters[0];
  let row: Withdrawal | null = null;
  for (table of rosters) {
    row = await db.prepare(`SELECT r.writer_id,r.split, e.writer_id IS NOT NULL AS live
      FROM ${table} r LEFT JOIN contributor_enrolments e USING(writer_id)
      WHERE e.receipt=?1 OR r.withdrawal_receipt_sha256=?2`).bind(receipt,receiptHash).first<Withdrawal>();
    if (row) break;
  }
  if (!row) return false;

  // This write closes consent, upload, and release eligibility before touching R2.
  if (row.live) {
    await db.prepare(`UPDATE contributor_enrolments SET withdrawn_at=?
      WHERE writer_id=? AND receipt=? AND withdrawn_at IS NULL`)
      .bind(new Date(ctx.now).toISOString(),row.writer_id,receipt).run();
  }
  const bucket = submissionBucket(ctx.env,row.split);
  if (!bucket) throw gone();
  const prefix = quarantinePrefix(row.writer_id);
  const published = await db.prepare(`SELECT storage_key FROM contributor_handwriting_publications
    WHERE storage_key>=? AND storage_key<?`).bind(prefix,prefix+"~").all<{storage_key:string}>();
  const preserve = new Set(published.results.map(row => row.storage_key));
  let cursor: string | undefined;
  try {
    do {
      const listed = await bucket.list({prefix,cursor,limit:100});
      const remove = listed.objects.map(object => object.key).filter(key => !preserve.has(key));
      if (remove.length) await bucket.delete(remove);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch {
    throw new HttpError(503,"contributor_withdrawal_pending");
  }

  if (row.live) {
    await db.batch([
      db.prepare(`UPDATE ${table} SET withdrawal_receipt_sha256=?
        WHERE writer_id=? AND withdrawal_receipt_sha256 IS NULL`).bind(receiptHash,row.writer_id),
      db.prepare(`UPDATE reviewers SET handwriting_opted_out=1 WHERE id=(
        SELECT writer_account FROM contributor_enrolments WHERE writer_id=? AND receipt=?)`).bind(row.writer_id,receipt),
      db.prepare("DELETE FROM contributor_submissions WHERE writer_id=?").bind(row.writer_id),
      db.prepare("DELETE FROM contributor_enrolments WHERE writer_id=? AND receipt=?").bind(row.writer_id,receipt),
    ]);
  }
  return true;
}
