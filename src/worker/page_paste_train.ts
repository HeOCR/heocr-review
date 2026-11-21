/// <reference lib="esnext.typedarrays" />

import { enteredPageLines, normalizePageBreaks, PAGE_PASTE_TEXT_LIMIT, type TrainingPage, type TrainingQueue } from "../shared/page_paste_train";
import { TRAIN_EXPORT_SQL, trainingExport, type TrainingExportRow } from "../tasks/page_paste_train/export";
import type { TrainingImage } from "../tasks/page_paste_train/schema";
import type { BatchRecord } from "../tasks/types";
import { HttpError } from "./http";

export async function trainingProgress(db: D1Database, batch: string, reviewerId: string) {
  return (await db.prepare(`SELECT COUNT(*) AS total, COUNT(d.page_id) AS completed,
    COUNT(CASE WHEN d.reviewer_id = ?2 THEN 1 END) AS own
    FROM page_paste_train_pages p LEFT JOIN page_paste_train_decisions d ON d.page_id = p.id
    WHERE p.batch_id = ?1`).bind(batch, reviewerId).first<{ total: number; completed: number; own: number }>())!;
}

interface PageRow {
  id: number;
  page_key: string;
  image_json: string;
  detected: number;
  number: number;
  total: number;
  previous_id: number | null;
  next_id: number | null;
  completed: number;
  saved_text: string | null;
  revision: number | null;
}

const TRAINING_PAGE_SQL = `SELECT p.id, p.page_key, p.image_json, json_array_length(p.line_boxes_json) AS detected,
  p.position + 1 AS number,
  (SELECT COUNT(*) FROM page_paste_train_pages WHERE batch_id = p.batch_id) AS total,
  (SELECT id FROM page_paste_train_pages WHERE batch_id = p.batch_id AND position < p.position ORDER BY position DESC LIMIT 1) AS previous_id,
  (SELECT id FROM page_paste_train_pages WHERE batch_id = p.batch_id AND position > p.position ORDER BY position LIMIT 1) AS next_id,
  d.page_id IS NOT NULL AS completed,
  CASE WHEN d.reviewer_id = ?2 THEN d.page_text END AS saved_text,
  CASE WHEN d.reviewer_id = ?2 THEN d.revision END AS revision
  FROM page_paste_train_pages p LEFT JOIN page_paste_train_decisions d ON d.page_id = p.id
  WHERE p.batch_id = ?1`;

function asTrainingPage(batch: string, row: PageRow): TrainingPage {
  const { width, height } = JSON.parse(row.image_json) as TrainingImage;
  return {
    id: row.id, key: row.page_key, detectedCount: row.detected, number: row.number, total: row.total,
    previousId: row.previous_id, nextId: row.next_id, completed: row.completed === 1,
    saved: row.saved_text === null ? null : { text: row.saved_text, revision: row.revision! },
    image: { url: `/api/page-paste-train/${encodeURIComponent(batch)}/pages/${row.id}/image`, width, height },
  };
}

export async function trainingPage(db: D1Database, batch: string, reviewer: string, page: number): Promise<TrainingQueue> {
  const row = await db.prepare(`${TRAINING_PAGE_SQL} AND p.id = ?3`).bind(batch, reviewer, page).first<PageRow>();
  if (!row) throw new HttpError(404, "not_found");
  return { page: asTrainingPage(batch, row) };
}

export async function nextTrainingPage(db: D1Database, batch: string, reviewer: string, after: number | null): Promise<TrainingQueue> {
  let position = -1;
  if (after !== null) {
    const row = await db.prepare("SELECT position FROM page_paste_train_pages WHERE batch_id = ?1 AND id = ?2")
      .bind(batch, after).first<{ position: number }>();
    if (!row) throw new HttpError(404, "not_found");
    position = row.position;
  }
  // Wrap after the last page so skips stay eligible on the next pass. Exclude the current page.
  const row = await db.prepare(`${TRAINING_PAGE_SQL} AND d.page_id IS NULL AND p.position != ?3
    ORDER BY p.position < ?3, p.position LIMIT 1`).bind(batch, reviewer, position).first<PageRow>();
  if (row) return { page: asTrainingPage(batch, row) };
  const first = await db.prepare("SELECT id FROM page_paste_train_pages WHERE batch_id = ?1 ORDER BY position LIMIT 1")
    .bind(batch).first<{ id: number }>();
  return { page: null, firstId: first?.id ?? null };
}

export async function saveTrainingPage(
  db: D1Database, batch: string, page: number, reviewer: { id: string; terms_version: string | null },
  text: unknown, revision: unknown, savedAt: string,
) {
  // Preserve marks, spacing and blank lines. Normalize only newlines so browser pastes and retries compare consistently.
  if (typeof text !== "string" || text.length > PAGE_PASTE_TEXT_LIMIT) throw new HttpError(400, "page_paste_text");
  const pageText = normalizePageBreaks(text);
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(pageText)) throw new HttpError(400, "page_paste_text");
  if (revision != null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) {
    throw new HttpError(400, "page_paste_text");
  }
  const entered = enteredPageLines(pageText);
  const applied = await db.prepare(`INSERT INTO page_paste_train_decisions
    (page_id, reviewer_id, page_text, entered_count, alignment_mismatch, terms_version, saved_at)
    SELECT p.id, ?3, ?4, ?5, json_array_length(p.line_boxes_json) != ?5, ?6, ?7
    FROM page_paste_train_pages p JOIN batches b ON b.id = p.batch_id
    WHERE p.batch_id = ?1 AND p.id = ?2 AND b.status = 'open'
      AND (?8 IS NULL OR EXISTS (SELECT 1 FROM page_paste_train_decisions WHERE page_id = p.id))
    ON CONFLICT (page_id) DO UPDATE SET page_text = excluded.page_text, entered_count = excluded.entered_count,
      alignment_mismatch = excluded.alignment_mismatch, terms_version = excluded.terms_version,
      saved_at = excluded.saved_at, revision = page_paste_train_decisions.revision + 1
    WHERE page_paste_train_decisions.reviewer_id = excluded.reviewer_id AND page_paste_train_decisions.revision = ?8
      AND page_paste_train_decisions.page_text != excluded.page_text
    RETURNING alignment_mismatch`)
    .bind(batch, page, reviewer.id, pageText, entered, reviewer.terms_version, savedAt, revision ?? null)
    .first<{ alignment_mismatch: number }>();
  if (applied) return { ok: true, alignmentMismatch: applied.alignment_mismatch === 1 };

  // An exact retry is safe even if the first response was lost.
  const stored = await db.prepare(`SELECT d.reviewer_id, d.page_text, d.alignment_mismatch FROM page_paste_train_decisions d
    JOIN page_paste_train_pages p ON p.id = d.page_id WHERE p.batch_id = ?1 AND p.id = ?2`)
    .bind(batch, page).first<{ reviewer_id: string; page_text: string; alignment_mismatch: number }>();
  if (!stored) throw new HttpError(revision == null ? 404 : 409, revision == null ? "not_found" : "page_paste_saved");
  if (stored.reviewer_id !== reviewer.id || stored.page_text !== pageText) throw new HttpError(409, "page_paste_saved");
  return { ok: true, alignmentMismatch: stored.alignment_mismatch === 1 };
}

export async function trainingAsset(db: D1Database, batch: string, page: number): Promise<Response> {
  const row = await db.prepare("SELECT image_json, asset_parts FROM page_paste_train_pages WHERE batch_id = ?1 AND id = ?2")
    .bind(batch, page).first<{ image_json: string; asset_parts: number }>();
  if (!row) throw new HttpError(404, "not_found");
  const { results } = await db.prepare("SELECT base64 FROM page_paste_train_assets WHERE page_id = ?1 ORDER BY part")
    .bind(page).all<{ base64: string }>();
  if (results.length !== row.asset_parts) throw new HttpError(404, "not_found");
  const { path } = JSON.parse(row.image_json) as TrainingImage;
  const type = path.endsWith(".png") ? "png" : path.endsWith(".webp") ? "webp" : "jpeg";
  const bytes = Uint8Array.fromBase64(results.map((part) => part.base64).join(""));
  return new Response(bytes, { headers: {
    "content-type": `image/${type}`, "cache-control": "private, no-store",
    "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
  } });
}

export async function trainingAdminProgress(db: D1Database, batch: string) {
  const { results } = await db.prepare(`SELECT d.reviewer_id AS id, COUNT(d.page_id) AS decisions,
    COUNT(*) AS pages, COALESCE(SUM(d.alignment_mismatch), 0) AS mismatches
    FROM page_paste_train_pages p LEFT JOIN page_paste_train_decisions d ON d.page_id = p.id
    WHERE p.batch_id = ?1 GROUP BY d.reviewer_id ORDER BY decisions DESC, id`)
    .bind(batch).all<{ id: string | null; pages: number; decisions: number; mismatches: number }>();
  return {
    counts: {
      pages: results.reduce((n, r) => n + r.pages, 0),
      completed: results.reduce((n, r) => n + r.decisions, 0),
      alignment_mismatches: results.reduce((n, r) => n + r.mismatches, 0),
    },
    reviewers: results.flatMap(({ id, decisions }) => id === null ? [] : [{ id, decisions }]),
  };
}

export async function trainingAdmin(db: D1Database, batch: BatchRecord, now: number) {
  const { results } = await db.prepare(TRAIN_EXPORT_SQL).bind(batch.id).all<TrainingExportRow>();
  return trainingExport(batch, results, new Date(now).toISOString());
}
