import { PAGE_SWEEP_BATCHES, type SweepLine, type SweepPage } from "../shared/page-sweep";
import { imageUrl, type Box } from "../shared/media";
import { sha256Hex } from "../shared/sha256";
import { TERMS_VERSION } from "../shared/terms";
import { taskType } from "../tasks/registry";
import { ALLOWED_REFERENCE_PROPOSAL, protectedReferenceBatchSql } from "../tasks/restricted_reference";
import { PROPOSAL_COLUMNS, toProposal, type ProposalRow } from "../tasks/rows";
import { PASS1_SQL, REGISTERED_PAGE_SQL } from "../tasks/line_verify/pagerecords";
import { candidateOf } from "../tasks/line_verify/triage";
import type { BatchRecord, StoredImage } from "../tasks/types";
import type { Ctx } from "./api";
import { readSession } from "./auth/session";
import { getBatch, getReviewer } from "./db";
import { randomId } from "./crypto";
import type { Env } from "./env";
import { assertSameOrigin, HttpError, json, readJson } from "./http";
import { canReadReference, privateReferenceImage, referenceImage, referenceReviewerAllowed } from "./restricted_reference";
import { enforce, LIMITS } from "./ratelimit";

const missing = () => new HttpError(404, "not_found");
const stale = () => new HttpError(409, "stale_draft");

export function canSweep(env: Env, url: URL, reviewer: string, batch: BatchRecord) {
  return env.PAGE_SWEEP_ENABLED === "1" && PAGE_SWEEP_BATCHES.some(id => id === batch.id) &&
    batch.taskType === "line_verify" && batch.settings?.mode === "triage" && batch.settings.pointedBooks === "keep" &&
    referenceReviewerAllowed(env, url, reviewer) && canReadReference(env, url, reviewer, batch);
}

async function access(c: Ctx, batchId: string, write: boolean) {
  if (write) assertSameOrigin(c.request);
  const reviewer = await readSession(c.env, c.request, c.now);
  if (!reviewer) throw new HttpError(401, "sign_in_required");
  const [user, batch] = await Promise.all([getReviewer(c.env.DB, reviewer), getBatch(c.env.DB, batchId)]);
  if (!user || user.blocked || batch?.status !== "open" || !canSweep(c.env, c.url, reviewer, batch)) throw missing();
  if (write && user.terms_version !== TERMS_VERSION) throw new HttpError(403, "terms_required");
  enforce(write ? LIMITS.writeMinute : LIMITS.readMinute, reviewer, c.now);
  return { reviewer, batch };
}

const lineScope = `p.active=1 AND ${PASS1_SQL} AND ${ALLOWED_REFERENCE_PROPOSAL}
  AND (p.gate_kind IS NULL OR p.gate_kind='always') AND json_extract(p.payload_json,'$.gold') IS NULL`;
const sweepRoster = `${REGISTERED_PAGE_SQL} AND (NOT ${protectedReferenceBatchSql("i.batch_id")} OR EXISTS(
  SELECT 1 FROM restricted_reference_pages rp WHERE rp.batch_id=i.batch_id AND rp.item_id=i.id AND rp.first_allowed=1))`;
const pageScope = `i.batch_id=?1 AND i.id=?2 AND ${sweepRoster}
  AND EXISTS(SELECT 1 FROM batches b JOIN batch_settings s ON s.batch_id=b.id
    WHERE b.id=i.batch_id AND b.status='open' AND s.mode='triage' AND s.pointed_books='keep')`;
const checkFree = "NOT EXISTS(SELECT 1 FROM page_checks WHERE batch_id=?1 AND item_id=?2 AND reviewer_id=?3 AND superseded_at IS NULL)";
const samePage = `EXISTS(SELECT 1 FROM items i WHERE ${pageScope})`;
const maxLines = 500;
type Row = ProposalRow & { old_id: string | null; value: string | null; text: string | null; matched: number; pending: number; skipped: number };
type Page = { id: number; title: string; payload_json: string; answer: string | null };

/* Old triage 'different' always needs an explicit decision. Previously answered plants also keep
   their desktop requirement. A sweep result is a separate, nonblind reference decision. */
const pending = `(d.value='different' OR (d.value IN ('correct','niqqud_mismatch') AND d.method='line'
  AND EXISTS(SELECT 1 FROM triage_plants t WHERE t.batch_id=p.batch_id AND t.proposal_id=p.id)))`;
const rowSql = `SELECT ${PROPOSAL_COLUMNS},d.id AS old_id,d.value,d.text,
  COALESCE(d.proposal_sha256=p.content_sha256,0) AS matched,COALESCE(${pending},0) AS pending,
  (sk.proposal_id IS NOT NULL) AS skipped
  FROM proposals p JOIN items i ON i.id=p.item_id
  LEFT JOIN decisions d ON d.proposal_id=p.id AND d.reviewer_id=?3 AND d.superseded_at IS NULL
  LEFT JOIN skips sk ON sk.proposal_id=p.id AND sk.reviewer_id=?3
  WHERE p.batch_id=?1 AND p.item_id=?2 AND ${lineScope}
  ORDER BY COALESCE(json_extract(p.payload_json,'$.line_index'),p.rank),p.id`;

function imageOf(page: Page, rows: Row[]): StoredImage | undefined {
  const payload = JSON.parse(page.payload_json) as { page_image?: StoredImage };
  return payload.page_image ?? rows.map(r => toProposal(r).media.page).find(Boolean);
}
function identity(r: Row) {
  return { id: r.id, sha: r.content_sha256, old: r.old_id, skipped: r.skipped };
}
function token(page: Page, rows: Row[]) {
  return sha256Hex(JSON.stringify([page.id, page.answer, rows.map(identity)]));
}
function boxOf(box: Box | null | undefined, text: string): Box | null {
  if (!box || box.length !== 4 || box.some(x => !Number.isFinite(x) || x < 0 || x > 1) ||
    box[2] - box[0] < 0.012 || box[3] - box[1] < 0.003 || !/[\p{L}\p{N}]/u.test(text)) return null;
  return box;
}
function stateOf(row: Row): SweepLine["state"] {
  if (row.matched && !row.pending) {
    if (row.value === "edited" || row.value === "typed") return "edited";
    return row.value === "exact" || row.value === "correct" ? "done" : "flagged";
  }
  if (row.skipped) return "skipped";
  return row.old_id ? "pending" : "open";
}
async function readPage(c: Ctx, batch: BatchRecord, reviewer: string, id: number) {
  const db = c.env.DB;
  const [pages, lines] = await db.batch([
    db.prepare(`SELECT i.id,i.title,i.payload_json,c.answer FROM items i
      LEFT JOIN page_checks c ON c.batch_id=i.batch_id AND c.item_id=i.id AND c.reviewer_id=?3 AND c.superseded_at IS NULL
      WHERE ${pageScope}`).bind(batch.id, id, reviewer),
    db.prepare(rowSql).bind(batch.id, id, reviewer),
  ]);
  const page = pages?.results[0] as unknown as Page | undefined;
  if (!page) throw missing();
  const rows = (lines?.results ?? []) as unknown as Row[];
  const image = imageOf(page, rows);
  if (!image) throw missing();
  return { page, rows, image };
}

const pendingPage = `i.batch_id=?1 AND ${sweepRoster}
  AND NOT EXISTS(SELECT 1 FROM page_checks ck WHERE ck.item_id=i.id AND ck.batch_id=i.batch_id AND ck.reviewer_id=?2 AND ck.superseded_at IS NULL)`;

export async function pendingSweepPages(db: D1Database, batchId: string, reviewer: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM items i WHERE ${pendingPage}`).bind(batchId, reviewer).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function sweepRead(c: Ctx, batchId: string, id?: number) {
  const { batch, reviewer } = await access(c, batchId, false);
  if (id === undefined) {
    const next = await c.env.DB.prepare(`SELECT i.id FROM items i WHERE ${pendingPage}
      ORDER BY (SELECT MIN(p.rank) FROM proposals p WHERE p.item_id=i.id AND p.batch_id=i.batch_id AND ${lineScope}) NULLS LAST,i.id LIMIT 1`)
      .bind(batch.id, reviewer).first<{ id: number }>();
    if (!next) return json({ page: null });
    id = next.id;
  }
  const { page, rows, image } = await readPage(c, batch, reviewer, id);
  const display = batch.restrictedReference
    ? referenceImage(image, `/api/page-sweep/${batch.id}/pages/${id}/image`)
    : image;
  if (!display) throw missing();
  const type = taskType(batch.taskType)!;
  const view: SweepPage = {
    id: page.id, title: page.title, token: token(page, rows),
    image: { url: imageUrl(display.ref), width: display.width, height: display.height },
    lines: rows.map((r, i) => {
      const p = toProposal(r);
      const state = stateOf(r);
      const text = (r.matched && !r.pending ? r.text : null) ?? candidateOf(p) ?? "";
      return { id: r.id, text, state, order: i + 1, box: boxOf(p.media.page?.box, text),
        options: (type.optionsFor?.(p) ?? []).filter(o => !["exact","edited","typed"].includes(o.value)) };
    }),
    final: page.answer === "complete" || page.answer === "lines_added", missing: page.answer === "missing_lines",
  };
  return json({ page: view });
}
export async function sweepImage(c: Ctx, batchId: string, id: number) {
  const { batch, reviewer } = await access(c, batchId, false);
  if (!batch.restrictedReference) throw missing();
  const { image } = await readPage(c, batch, reviewer, id);
  return privateReferenceImage(c.env, batch.id, image);
}

// Recheck the whole rendered roster and decision/skip versions as part of the write transaction.
const exactWitness = `(SELECT COUNT(*) FROM proposals p WHERE p.batch_id=?1 AND p.item_id=?2 AND ${lineScope})=json_array_length(?4)
  AND NOT EXISTS (SELECT 1 FROM json_each(?4) j WHERE NOT EXISTS(
    SELECT 1 FROM proposals p
    LEFT JOIN decisions d ON d.proposal_id=p.id AND d.reviewer_id=?3 AND d.superseded_at IS NULL
    LEFT JOIN skips sk ON sk.proposal_id=p.id AND sk.reviewer_id=?3
    WHERE p.batch_id=?1 AND p.item_id=?2 AND ${lineScope} AND p.id=json_extract(j.value,'$.id')
      AND p.content_sha256=json_extract(j.value,'$.sha') AND d.id IS json_extract(j.value,'$.old')
      AND (sk.proposal_id IS NOT NULL)=json_extract(j.value,'$.skipped')))`;

export async function sweepWrite(c: Ctx, batchId: string, id: number) {
  const { batch, reviewer } = await access(c, batchId, true);
  const body = await readJson(c.request);
  const { page, rows } = await readPage(c, batch, reviewer, id);
  // A retired or already-checked page never receives an implicit second decision.
  if (page.answer || body.token !== token(page, rows)) throw stale();
  if (rows.length > maxLines) throw new HttpError(409, "not_open");
  const db = c.env.DB;
  const now = new Date(c.now).toISOString();
  const day = now.slice(0,10);
  const base = [batch.id, id, reviewer] as const;
  if (body.action === "finish" || body.action === "missing_lines") {
    if (rows.some(r => stateOf(r) === "pending" || stateOf(r) === "skipped")) throw new HttpError(409,"not_open");
    const witness = JSON.stringify(rows.map(identity));
    const checkId = randomId("pc-");
    const inserts = JSON.stringify(rows.filter(r => !r.old_id).map(r => ({ ...identity(r), decision: randomId("hr-") })));
    const [check, lines] = await db.batch([
      db.prepare(`INSERT INTO page_checks (id,batch_id,item_id,reviewer_id,answer,created_at,decided_on,method)
        SELECT ?5,?1,?2,?3,?8,?6,?7,'page_sweep'
        WHERE ${samePage} AND ${checkFree} AND ${exactWitness}
          AND NOT EXISTS(SELECT 1 FROM proposals p WHERE p.batch_id=?1 AND p.item_id=?2 AND p.active=1 AND ${PASS1_SQL} AND NOT(${lineScope}))`)
        .bind(...base,witness,checkId,now,day,body.action === "finish" ? "complete" : "missing_lines"),
      db.prepare(`INSERT INTO decisions (id,proposal_id,reviewer_id,value,text,proposal_sha256,terms_version,created_at,decided_on,method)
        SELECT json_extract(j.value,'$.decision'),json_extract(j.value,'$.id'),?3,'exact',NULL,json_extract(j.value,'$.sha'),?6,?7,?8,'page_sweep'
        FROM json_each(?4) j WHERE EXISTS(SELECT 1 FROM page_checks WHERE batch_id=?1 AND item_id=?2 AND reviewer_id=?3 AND id=?5)`)
        .bind(...base,inserts,checkId,TERMS_VERSION,now,day),
    ]);
    if (check?.meta.changes !== 1) throw stale();
    return json({ complete: true, written: lines?.meta.changes ?? 0 });
  }
  if (body.action !== "edit" || !Number.isSafeInteger(body.line) || typeof body.value !== "string") throw new HttpError(400,"invalid_decision");
  const row = rows.find(r => r.id === body.line);
  if (!row || !["open","pending","skipped"].includes(stateOf(row))) throw stale();
  const p = toProposal(row);
  const type = taskType(batch.taskType)!;
  const value = body.value === "edited" && p.payload.kind === "type" ? "typed" : body.value;
  if (!type.optionsFor?.(p).some(o => o.value === value)) throw new HttpError(400,"invalid_decision");
  const normalized = type.normalizeDecision(p, value, body.text);
  if (!normalized.ok) throw new HttpError(400,"invalid_decision",normalized.error);
  const guard = `${samePage} AND ${checkFree} AND EXISTS(SELECT 1 FROM proposals p WHERE p.id=?4
    AND p.batch_id=?1 AND p.item_id=?2 AND p.content_sha256=?5 AND ${lineScope})`;
  const decisionId = randomId("hr-");
  const [, write] = await db.batch([
    db.prepare(`UPDATE decisions SET superseded_at=?7 WHERE id=?6 AND proposal_id=?4 AND reviewer_id=?3 AND superseded_at IS NULL AND ${guard}`)
      .bind(...base,row.id,row.content_sha256,row.old_id,now),
    db.prepare(`INSERT INTO decisions (id,proposal_id,reviewer_id,value,text,proposal_sha256,terms_version,created_at,decided_on,method)
      SELECT ?6,?4,?3,?7,?8,?5,?9,?10,?11,'page_sweep' WHERE ${guard}
      AND NOT EXISTS(SELECT 1 FROM decisions WHERE proposal_id=?4 AND reviewer_id=?3 AND superseded_at IS NULL)`)
      .bind(...base,row.id,row.content_sha256,decisionId,normalized.value,normalized.text,TERMS_VERSION,now,day),
    db.prepare(`DELETE FROM skips WHERE proposal_id=?1 AND reviewer_id=?2 AND EXISTS(SELECT 1 FROM decisions WHERE id=?3)`)
      .bind(row.id,reviewer,decisionId),
  ]);
  if (write?.meta.changes !== 1) throw stale();
  return sweepRead(c, batch.id, id);
}
