import { allowedReferencePage } from "../restricted_reference";
/** The export's page records (migrations/0014_page_completeness.sql), read the same way by the Worker and scripts/export.ts. */
import type { TriagePages } from "../types";

export const PASS1_SQL = "COALESCE(json_extract(p.payload_json, '$.pass'), 1) = 1";

// Current manifest entries include unboxed pages. Older imports without item-level registration are represented by
// their active pass-1 proposals. Inactive historical items must not enter the queue or the reference export.
export const REGISTERED_PAGE_SQL = `${allowedReferencePage("i.batch_id", "i.id")} AND (json_extract(i.payload_json, '$.line_verify_imported_at') =
    (SELECT b.imported_at FROM batches b WHERE b.id = i.batch_id)
  OR EXISTS (SELECT 1 FROM proposals p WHERE p.item_id = i.id AND p.active = 1 AND ${PASS1_SQL}))`;
export const TRIAGE_PAGES_SQL = `SELECT i.external_id AS page_id, json_extract(i.payload_json, '$.width') AS width,
  json_extract(i.payload_json, '$.height') AS height FROM items i
  WHERE i.batch_id = ?1 AND ${REGISTERED_PAGE_SQL} ORDER BY i.id`;

export interface TriagePageRow {
  page_id: string;
  width: number | null;
  height: number | null;
}

/** Every current page check, with the timestamp of its missing-lines answer. */
export const PAGE_CHECKS_SQL = `SELECT i.external_id AS page_id, c.reviewer_id, c.answer, c.created_at,
  (SELECT MAX(e.created_at) FROM page_checks e WHERE e.item_id = c.item_id AND e.reviewer_id = c.reviewer_id AND e.answer = 'missing_lines' AND e.created_at <= c.created_at) AS missing_at
  FROM page_checks c JOIN items i ON i.id = c.item_id WHERE c.batch_id = ?1 AND c.superseded_at IS NULL AND ${allowedReferencePage("i.batch_id", "i.id")}`;
/** Every added line not removed. */
export const ADDED_LINES_SQL = `SELECT a.id, i.external_id AS page_id, a.reviewer_id, a.box_json, a.text, a.value, a.created_at
  FROM page_added_lines a JOIN items i ON i.id = a.item_id WHERE a.batch_id = ?1 AND a.removed_at IS NULL AND ${allowedReferencePage("i.batch_id", "i.id")} ORDER BY a.created_at, a.id`;

export interface PageCheckRow {
  page_id: string;
  reviewer_id: string;
  answer: "complete" | "missing_lines" | "lines_added";
  created_at: string;
  missing_at: string | null;
}
export interface AddedLineRow {
  id: string;
  page_id: string;
  reviewer_id: string;
  box_json: string;
  text: string | null;
  value: "typed" | "unreadable";
  created_at: string;
}

export function toTriagePages(pages: TriagePageRow[], checks: PageCheckRow[], added: AddedLineRow[]): TriagePages {
  return {
    pages: pages.map((p) => ({ pageId: p.page_id, width: p.width, height: p.height })),
    checks: checks.map((c) => ({ pageId: c.page_id, reviewerId: c.reviewer_id, answer: c.answer, decidedAt: c.created_at, missingAt: c.missing_at })),
    added: added.map((a) => ({
      id: a.id,
      pageId: a.page_id,
      reviewerId: a.reviewer_id,
      box: JSON.parse(a.box_json) as [number, number, number, number],
      text: a.text,
      value: a.value,
      decidedAt: a.created_at,
    })),
  };
}
