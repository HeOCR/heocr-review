/** Unsaved page corrections kept on the server (migrations/0004_drafts.sql). The check is pure: shared with the tests. */
import type { PageDraftRow } from "../shared/api";
import { LINE_ACTIONS, MAX_LINES } from "../tasks/page_review/schema";

/** Longer than one typed line may be (a merge joins lines); the decision's own check still applies on confirm. */
const MAX_DRAFT_TEXT = 4000;

export type DraftCheck =
  | { ok: true; body: { readingOrder: boolean; rows: PageDraftRow[] } }
  | { ok: false; error: string };

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v);

/** Keep only the fields a draft has, of the right types, on lines the page shows. */
export function checkDraft(
  input: Record<string, unknown>,
  shown: Set<number>,
): DraftCheck {
  const fail = (error: string): DraftCheck => ({ ok: false, error });
  if (typeof input.readingOrder !== "boolean")
    return fail("readingOrder must be a boolean");
  if (!Array.isArray(input.rows) || input.rows.length > 2 * MAX_LINES)
    return fail("rows must be a list");
  const rows: PageDraftRow[] = [];
  for (const [k, r] of input.rows.entries()) {
    const row = r as Record<string, unknown>;
    if (!row || typeof row !== "object")
      return fail(`row ${k + 1} must be an object`);
    if (
      !Array.isArray(row.src) ||
      row.src.length > MAX_LINES ||
      !row.src.every((i) => isInt(i) && shown.has(i))
    )
      return fail(`row ${k + 1}: src must be lines of this page`);
    if (!(LINE_ACTIONS as readonly unknown[]).includes(row.action))
      return fail(`row ${k + 1}: unknown action`);
    if (!(
      row.text === null ||
      (typeof row.text === "string" && row.text.length <= MAX_DRAFT_TEXT)
    ))
      return fail(`row ${k + 1}: text must be a string or null`);
    if (typeof row.looked !== "boolean")
      return fail(`row ${k + 1}: looked must be a boolean`);
    rows.push({
      src: [...(row.src as number[])],
      action: row.action as string,
      text: row.text as string | null,
      looked: row.looked,
    });
  }
  return { ok: true, body: { readingOrder: input.readingOrder, rows } };
}
