import type { PagePasteQueue } from "../shared/api";
import { imageUrl } from "../shared/media";
import { pagePasteLines } from "../shared/page_paste";
import { sha256Hex } from "../shared/sha256";
import { TERMS_VERSION } from "../shared/terms";
import { normalizeTypedDecision } from "../tasks/line_verify";
import { PINNED_PAGE_MATCHES, type PagePastePin } from "../tasks/line_verify/page_paste";
import type { StoredImage } from "../tasks/types";
import { randomId } from "./crypto";
import { HttpError } from "./http";

interface QueuePage { item_id: number; line_pins_json: string; title: string; image_json: string | null; matches: number }
interface SavedPage { line_pins_json: string; submission_sha256: string | null; matches: number }

export async function pagePasteProgress(db: D1Database, batch: string, reviewer: string) {
  return (await db.prepare(`SELECT COUNT(*) AS total, COUNT(submitted_at) AS completed
    FROM page_paste_pages WHERE batch_id = ?1 AND reviewer_id = ?2`).bind(batch, reviewer)
    .first<{ total: number; completed: number }>())!;
}

export async function nextPagePaste(db: D1Database, batch: string, reviewer: string): Promise<PagePasteQueue> {
  const [progress, row] = await Promise.all([
    pagePasteProgress(db, batch, reviewer),
    db.prepare(`SELECT pp.item_id, pp.line_pins_json, i.title, (${PINNED_PAGE_MATCHES}) AS matches,
        COALESCE(json_extract(i.payload_json, '$.page_image'),
          (SELECT json_extract(p.media_json, '$.page') FROM proposals p
            WHERE p.id = json_extract(pp.line_pins_json, '$[0].id'))) AS image_json
      FROM page_paste_pages pp JOIN items i ON i.id = pp.item_id
      WHERE pp.batch_id = ?1 AND pp.reviewer_id = ?2 AND pp.submitted_at IS NULL ORDER BY pp.ordinal LIMIT 1`)
      .bind(batch, reviewer).first<QueuePage>(),
  ]);
  if (!progress.total) throw new HttpError(404, "not_found");
  if (!row) return { ...progress, page: null };
  if (!row.matches || !row.image_json) throw new HttpError(409, "page_paste_stale");
  const image = JSON.parse(row.image_json) as StoredImage;
  const pins = JSON.parse(row.line_pins_json) as PagePastePin[];
  return { ...progress, page: {
    itemId: row.item_id, title: row.title, expected: pins.length,
    image: { url: imageUrl(image.ref), width: image.width, height: image.height, box: null, outlined: false },
  } };
}

/** Save a full page atomically. Claims prevent duplicate writes; the same retry may advance after a lost reply. */
export async function savePagePaste(db: D1Database, batch: string, item: number, reviewer: string, text: unknown, nowIso: string) {
  const page = () => db.prepare(`SELECT pp.line_pins_json, pp.submission_sha256, (${PINNED_PAGE_MATCHES}) AS matches
    FROM page_paste_pages pp WHERE pp.batch_id = ?1 AND pp.item_id = ?2 AND pp.reviewer_id = ?3`)
    .bind(batch, item, reviewer).first<SavedPage>();
  const row = await page();
  if (!row) throw new HttpError(404, "not_found");
  if (typeof text !== "string") throw new HttpError(400, "invalid_decision");
  const entered = pagePasteLines(text);
  const pins = JSON.parse(row.line_pins_json) as PagePastePin[];
  if (entered.length !== pins.length) throw new HttpError(400, "page_paste_count",
    `Expected ${pins.length} lines; received ${entered.length}.`);
  const lines = entered.map((line, i) => {
    const normalized = normalizeTypedDecision("typed", line);
    if (!normalized.ok) throw new HttpError(400, "page_paste_invalid_line", String(i + 1));
    return normalized.text!;
  });
  const digest = sha256Hex(JSON.stringify(lines));
  if (row.submission_sha256 === digest) return { saved: pins.length };
  if (!row.matches || row.submission_sha256 !== null) throw new HttpError(409, "page_paste_stale");

  const claim = randomId("pp-", 16);
  const ownsClaim = "EXISTS (SELECT 1 FROM page_paste_pages pp WHERE pp.item_id = ?1 AND pp.submission_id = ?2)";
  const submissions = JSON.stringify(lines.map((line, i) => ({ id: randomId("hr-"), proposal: pins[i]!.id, text: line })));
  const results = await db.batch([
    db.prepare(`UPDATE page_paste_pages AS pp SET submitted_at = ?4, submission_id = ?5, submission_sha256 = ?6
      WHERE pp.item_id = ?1 AND pp.batch_id = ?2 AND pp.reviewer_id = ?3 AND pp.submitted_at IS NULL
      AND EXISTS (SELECT 1 FROM batches b JOIN batch_settings s ON s.batch_id = b.id
        WHERE b.id = pp.batch_id AND b.status = 'open' AND s.mode = 'triage')
      AND ${PINNED_PAGE_MATCHES}`).bind(item, batch, reviewer, nowIso, claim, digest),
    db.prepare(`UPDATE decisions SET superseded_at = ?4
      WHERE ${ownsClaim} AND reviewer_id = ?3 AND superseded_at IS NULL
      AND proposal_id IN (SELECT json_extract(j.value, '$.proposal') FROM json_each(?5) j)`)
      .bind(item, claim, reviewer, nowIso, submissions),
    db.prepare(`INSERT INTO decisions (id, proposal_id, reviewer_id, value, text, proposal_sha256,
        terms_version, created_at, decided_on, correction_start)
      SELECT json_extract(j.value, '$.id'), p.id, ?3, CASE WHEN json_extract(p.payload_json, '$.kind') = 'type' THEN 'typed' ELSE 'edited' END,
        json_extract(j.value, '$.text'), p.content_sha256, ?6, ?4, ?7, 'page_paste'
      FROM json_each(?5) j JOIN proposals p ON p.id = json_extract(j.value, '$.proposal') WHERE ${ownsClaim}`)
      .bind(item, claim, reviewer, nowIso, submissions, TERMS_VERSION, nowIso.slice(0, 10)),
  ]);
  if (!results[0]?.meta.changes && (await page())?.submission_sha256 !== digest) throw new HttpError(409, "page_paste_stale");
  return { saved: pins.length };
}
