import { MACHINE_ACCEPTED } from "./reference-consensus";
import { ALLOWED_REFERENCE_PROPOSAL, allowedReferencePage, isRestrictedDraftVerification, protectedReferenceBatchSql } from "../tasks/restricted_reference";
import { referenceImage, RESTRICTED_MEDIA_PATH } from "./restricted_reference";
/**
 * Page completeness in triage (migrations/0014_page_completeness.sql; heocr-eval's reference_triage_v1 amendment 1).
 *
 * Triage queues a page once all its active pass-1 lines have settled, including desktop fixes.
 * The reviewer sees the scan with all its boxes and answers "is every printed line boxed?". 'missing_lines' puts the page in the reviewer's desktop queue (before its lines), where they
 * box and type each missing line, then finish ('lines_added').
 */
import type { PageCheckView, PageLineBox } from "../shared/api";
import { imageUrl } from "../shared/media";
import { normalizeTypedDecision } from "../tasks/line_verify";
import { PASS1_SQL, REGISTERED_PAGE_SQL } from "../tasks/line_verify/pagerecords";
import { CONTENT_MATCH_SQL, PENDING_SQL } from "../tasks/line_verify/triage";
import type { BatchRecord, StoredImage } from "../tasks/types";
import { randomId } from "./crypto";

export const PAGE_ANSWERS = ["complete", "missing_lines"] as const;
/** Every active pass-1 line on the page must have a current, settled answer on this content from reviewer ?2. */
const PAGE_ANSWERED = `NOT EXISTS (SELECT 1 FROM proposals p WHERE p.item_id = i.id AND p.active = 1 AND ${PASS1_SQL}
  AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2
    AND d.superseded_at IS NULL AND ${CONTENT_MATCH_SQL} AND NOT ${PENDING_SQL("d")}))`;
const DRAFTS_ANSWERED = `NOT EXISTS (SELECT 1 FROM proposals p WHERE p.batch_id = i.batch_id
  AND p.active = 1 AND ${PASS1_SQL} AND ${ALLOWED_REFERENCE_PROPOSAL} AND NOT ${MACHINE_ACCEPTED}
  AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.proposal_id = p.id AND d.reviewer_id = ?2
    AND d.superseded_at IS NULL AND ${CONTENT_MATCH_SQL} AND d.value IN ('exact','edited')))`;
const CURRENT = (answer: string) =>
  `EXISTS (SELECT 1 FROM page_checks c WHERE c.item_id = i.id AND c.reviewer_id = ?2 AND c.superseded_at IS NULL AND c.answer = '${answer}')`;
const NO_CHECK = "NOT EXISTS (SELECT 1 FROM page_checks c WHERE c.item_id = i.id AND c.reviewer_id = ?2 AND c.superseded_at IS NULL)";
const FIRST_RANK = `(SELECT MIN(p.rank) FROM proposals p WHERE p.item_id = i.id AND p.active = 1 AND ${ALLOWED_REFERENCE_PROPOSAL})`;
const pageCoverage = "(SELECT rp.coverage_boxes_json FROM restricted_reference_pages rp WHERE rp.batch_id=i.batch_id AND rp.item_id=i.id)";
const coverageReady = `(NOT ${protectedReferenceBatchSql("i.batch_id")}
  OR (json_extract(i.payload_json, '$.page_image.ref.source')='r2' AND ${pageCoverage} IS NOT NULL)
  OR EXISTS (SELECT 1 FROM proposals p WHERE p.item_id=i.id AND p.batch_id=i.batch_id AND p.active=1
    AND ${PASS1_SQL} AND json_extract(p.media_json, '$.page.ref.source')='r2'))`;

/** SQL: the pages waiting for the reviewer's check (triage) or for their missing lines (desktop). */
const toCheck = (verification = false) => `FROM items i WHERE i.batch_id = ?1 AND ${REGISTERED_PAGE_SQL}
  AND ${NO_CHECK} AND ${verification ? DRAFTS_ANSWERED : PAGE_ANSWERED} AND ${coverageReady}`;
const TO_ADD = `FROM items i WHERE i.batch_id = ?1 AND ${REGISTERED_PAGE_SQL} AND ${CURRENT("missing_lines")} AND ${coverageReady}`;

export async function pageCounts(db: D1Database, batchId: string, reviewerId: string): Promise<{ check: number; add: number }> {
  const row = await db
    .prepare(`SELECT (SELECT COUNT(*) ${toCheck()}) AS c, (SELECT COUNT(*) ${TO_ADD}) AS a`)
    .bind(batchId, reviewerId)
    .first<{ c: number; a: number }>();
  return { check: row?.c ?? 0, add: row?.a ?? 0 };
}

export async function verificationPageProgress(db: D1Database, batchId: string, reviewerId: string): Promise<{ total: number; done: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(${CURRENT("complete")} OR ${CURRENT("lines_added")}),0) AS done
    FROM items i WHERE i.batch_id = ?1 AND ${REGISTERED_PAGE_SQL}`)
    .bind(batchId, reviewerId)
    .first<{ total: number; done: number }>();
  return row ?? { total: 0, done: 0 };
}

/** The next page for the reviewer in this queue (triage: a check; fix: missing lines to add), or null. */
type PageRow = { id: number; external_id: string; title: string; page_image: string | null; coverage_boxes: string | null };
const pageFields = `i.id, i.external_id, i.title, json_extract(i.payload_json, '$.page_image') AS page_image,
  ${pageCoverage} AS coverage_boxes`;

export async function nextPage(db: D1Database, batch: BatchRecord, reviewerId: string, queue: "triage" | "fix"): Promise<PageCheckView | null> {
  const row = await db
    .prepare(`SELECT ${pageFields} ${queue === "triage" ? toCheck(isRestrictedDraftVerification(batch)) : TO_ADD} ORDER BY ${FIRST_RANK}, i.id LIMIT 1`)
    .bind(batch.id, reviewerId)
    .first<PageRow>();
  return row ? pageView(db, batch, row, reviewerId, queue === "triage" ? "check" : "add") : null;
}

async function pageMedia(db: D1Database, item: PageRow) {
  const { results } = await db
    .prepare(`SELECT p.media_json, json_extract(p.payload_json, '$.line_index') AS line_index
      FROM proposals p WHERE p.item_id=?1 AND p.active=1 AND ${PASS1_SQL} AND ${ALLOWED_REFERENCE_PROPOSAL} ORDER BY line_index`)
    .bind(item.id)
    .all<{ media_json: string; line_index: number | null }>();
  let image = item.page_image ? JSON.parse(item.page_image) as StoredImage : undefined;
  const boxes: PageLineBox[] = item.coverage_boxes ? JSON.parse(item.coverage_boxes) as PageLineBox[] : [];
  for (const row of results) {
    const page = (JSON.parse(row.media_json) as { page?: StoredImage }).page;
    if (!page) continue;
    image ??= page;
    if (!item.coverage_boxes && page.box) boxes.push({ box: page.box, lineIndex: row.line_index ?? boxes.length });
  }
  return { image, boxes };
}

export async function completenessImage(db: D1Database, batch: BatchRecord, reviewerId: string, itemId: number) {
  const item = await db.prepare(`SELECT ${pageFields} ${toCheck(isRestrictedDraftVerification(batch))} AND i.id=?3
    UNION ALL SELECT ${pageFields} ${TO_ADD} AND i.id=?3 LIMIT 1`).bind(batch.id, reviewerId, itemId).first<PageRow>();
  return item ? (await pageMedia(db, item)).image : undefined;
}

async function pageView(db: D1Database, batch: BatchRecord, item: PageRow, reviewerId: string, mode: "check" | "add"): Promise<PageCheckView> {
  const media = await pageMedia(db, item);
  const image = batch.restrictedReference
    ? referenceImage(media.image, `${RESTRICTED_MEDIA_PATH}/batches/${batch.id}/pages/${item.id}`)
    : media.image;
  const added = mode === "add" ? await addedLines(db, item.id, reviewerId) : [];
  return {
    batchId: batch.id,
    itemId: item.id,
    pageId: item.external_id,
    title: item.title,
    mode,
    image: image ? { url: imageUrl(image.ref), width: image.width, height: image.height, box: null, outlined: false } : null,
    boxes: media.boxes,
    added,
  };
}

async function addedLines(db: D1Database, itemId: number, reviewerId: string) {
  const { results } = await db
    .prepare("SELECT id, box_json, text, value FROM page_added_lines WHERE item_id = ?1 AND reviewer_id = ?2 AND removed_at IS NULL ORDER BY created_at")
    .bind(itemId, reviewerId)
    .all<{ id: string; box_json: string; text: string | null; value: "typed" | "unreadable" }>();
  return results.map((r) => ({ id: r.id, box: JSON.parse(r.box_json) as [number, number, number, number], text: r.text, value: r.value }));
}

/** The item of a page in this batch, or null. */
export async function pageItem(db: D1Database, batchId: string, itemId: number): Promise<{ id: number } | null> {
  return db.prepare(`SELECT i.id FROM items i WHERE i.batch_id = ?1 AND i.id = ?2 AND ${allowedReferencePage("i.batch_id", "i.id")}`).bind(batchId, itemId).first<{ id: number }>();
}

/** Record the first check only if the same page-readiness predicate used by the queue still holds. */
export async function recordInitialPageCheck(db: D1Database, batch: BatchRecord, itemId: number, reviewerId: string, answer: "complete" | "missing_lines", nowIso: string): Promise<boolean> {
  const res = await db
    .prepare(`INSERT INTO page_checks (id, batch_id, item_id, reviewer_id, answer, created_at, decided_on)
      SELECT ?4, ?1, i.id, ?2, ?5, ?6, ?7 ${toCheck(isRestrictedDraftVerification(batch))} AND i.id = ?3`)
    .bind(batch.id, reviewerId, itemId, randomId("pc-"), answer, nowIso, nowIso.slice(0, 10))
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Complete the missing-lines workflow without changing the timestamp of its original check. */
export async function recordPageCheck(db: D1Database, batchId: string, itemId: number, reviewerId: string, nowIso: string): Promise<boolean> {
  const [ , inserted ] = await db.batch([
    db.prepare(`UPDATE page_checks SET superseded_at=?4
      WHERE batch_id=?1 AND item_id=?2 AND reviewer_id=?3 AND superseded_at IS NULL AND answer='missing_lines'
        AND (NOT ${protectedReferenceBatchSql("?1")} OR EXISTS (SELECT 1 FROM page_added_lines a
          WHERE a.batch_id=?1 AND a.item_id=?2 AND a.reviewer_id=?3 AND a.removed_at IS NULL))`)
      .bind(batchId, itemId, reviewerId, nowIso),
    db.prepare(`INSERT INTO page_checks (id, batch_id, item_id, reviewer_id, answer, created_at, decided_on)
      SELECT ?6, ?1, ?2, ?3, 'lines_added', ?4, ?5 FROM page_checks prev
      WHERE prev.batch_id=?1 AND prev.item_id=?2 AND prev.reviewer_id=?3
        AND prev.answer='missing_lines' AND prev.superseded_at=?4
        AND NOT EXISTS (SELECT 1 FROM page_checks current
          WHERE current.item_id=?2 AND current.reviewer_id=?3 AND current.superseded_at IS NULL)
      LIMIT 1`).bind(batchId, itemId, reviewerId, nowIso, nowIso.slice(0, 10), randomId("pc-")),
  ]);
  return (inserted?.meta.changes ?? 0) > 0;
}

export async function currentCheck(db: D1Database, itemId: number, reviewerId: string): Promise<string | null> {
  const row = await db.prepare("SELECT answer FROM page_checks WHERE item_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL").bind(itemId, reviewerId).first<{ answer: string }>();
  return row?.answer ?? null;
}

/** A box in page fractions, x0 < x1 and y0 < y1, at least a sliver tall and wide. */
export function boxProblem(box: unknown): string | null {
  if (!(Array.isArray(box) && box.length === 4 && box.every((v) => typeof v === "number" && Number.isFinite(v)))) return "box must be [x0, y0, x1, y1] in page fractions";
  const [x0, y0, x1, y1] = box as number[];
  if (!(0 <= x0! && x0! < x1! && x1! <= 1 && 0 <= y0! && y0! < y1! && y1! <= 1)) return "box must lie on the page with x0 < x1 and y0 < y1";
  if (x1! - x0! < 0.005 || y1! - y0! < 0.003) return "box is too small";
  return null;
}

/** An added line: typed (the typed-line rule: one NFC line, letters only, "[?]" allowed) or unreadable. */
export function normalizeAdded(value: unknown, text: unknown): { ok: true; value: "typed" | "unreadable"; text: string | null } | { ok: false; error: string } {
  if (value === "unreadable") return text === undefined || text === null ? { ok: true, value, text: null } : { ok: false, error: "an unreadable line has no text" };
  if (value !== "typed") return { ok: false, error: "value must be typed or unreadable" };
  const n = normalizeTypedDecision("typed", text);
  return n.ok ? { ok: true, value: "typed", text: n.text } : { ok: false, error: n.error };
}

export async function addLine(db: D1Database, batchId: string, itemId: number, reviewerId: string, box: number[], value: "typed" | "unreadable", text: string | null, nowIso: string): Promise<string | null> {
  const id = randomId("pl-");
  const result = await db
    .prepare(`INSERT INTO page_added_lines (id, batch_id, item_id, reviewer_id, box_json, text, value, created_at, decided_on)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (
        SELECT 1 FROM page_checks c WHERE c.batch_id=?2 AND c.item_id=?3 AND c.reviewer_id=?4
          AND c.superseded_at IS NULL AND c.answer='missing_lines')`)
    .bind(id, batchId, itemId, reviewerId, JSON.stringify(box), text, value, nowIso, nowIso.slice(0, 10))
    .run();
  return (result.meta.changes ?? 0) > 0 ? id : null;
}

export async function removeLine(db: D1Database, batchId: string, lineId: string, reviewerId: string, nowIso: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE page_added_lines SET removed_at=?4 WHERE id=?1 AND batch_id=?2 AND reviewer_id=?3 AND removed_at IS NULL
      AND ${allowedReferencePage("page_added_lines.batch_id", "page_added_lines.item_id")}
      AND (NOT ${protectedReferenceBatchSql("?2")} OR EXISTS (SELECT 1 FROM page_checks c
        WHERE c.batch_id=?2 AND c.item_id=page_added_lines.item_id AND c.reviewer_id=?3
          AND c.superseded_at IS NULL AND c.answer='missing_lines'))`)
    .bind(lineId, batchId, reviewerId, nowIso)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

