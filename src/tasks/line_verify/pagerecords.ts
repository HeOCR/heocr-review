/** The export's page records (migrations/0014_page_completeness.sql), read the same way by the Worker and scripts/export.ts. */
import type { TriagePages } from "../types";

/** Every current page check, with the day the page was first marked as missing lines. */
export const PAGE_CHECKS_SQL = `SELECT i.external_id AS page_id, c.reviewer_id, c.answer, c.decided_on,
  (SELECT MIN(e.decided_on) FROM page_checks e WHERE e.item_id = c.item_id AND e.reviewer_id = c.reviewer_id AND e.answer = 'missing_lines') AS missing_on
  FROM page_checks c JOIN items i ON i.id = c.item_id WHERE c.batch_id = ?1 AND c.superseded_at IS NULL`;
/** Every added line not removed. */
export const ADDED_LINES_SQL = `SELECT a.id, i.external_id AS page_id, a.reviewer_id, a.box_json, a.text, a.value, a.decided_on
  FROM page_added_lines a JOIN items i ON i.id = a.item_id WHERE a.batch_id = ?1 AND a.removed_at IS NULL ORDER BY a.created_at, a.id`;

export interface PageCheckRow {
  page_id: string;
  reviewer_id: string;
  answer: "complete" | "missing_lines" | "lines_added";
  decided_on: string;
  missing_on: string | null;
}
export interface AddedLineRow {
  id: string;
  page_id: string;
  reviewer_id: string;
  box_json: string;
  text: string | null;
  value: "typed" | "unreadable";
  decided_on: string;
}

export function toTriagePages(checks: PageCheckRow[], added: AddedLineRow[]): TriagePages {
  return {
    checks: checks.map((c) => ({ pageId: c.page_id, reviewerId: c.reviewer_id, answer: c.answer, decidedOn: c.decided_on, missingOn: c.missing_on })),
    added: added.map((a) => ({
      id: a.id,
      pageId: a.page_id,
      reviewerId: a.reviewer_id,
      box: JSON.parse(a.box_json) as [number, number, number, number],
      text: a.text,
      value: a.value,
      decidedOn: a.decided_on,
    })),
  };
}
