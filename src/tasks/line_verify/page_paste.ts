import { PASS1_SQL } from "./pagerecords";

export const PAGE_PASTE_REGISTRATION = "page_paste_registration.v1";

export interface PagePasteRegistration {
  schema: typeof PAGE_PASTE_REGISTRATION;
  batch_id: string;
  page_ids: string[];
}

/** A separate list from eval, pinned by its SHA-256. Its order is the review order. */
export function parsePagePasteRegistration(value: unknown): PagePasteRegistration {
  const file = value as Partial<PagePasteRegistration> | null;
  if (!file || file.schema !== PAGE_PASTE_REGISTRATION || typeof file.batch_id !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(file.batch_id) || !Array.isArray(file.page_ids) || !file.page_ids.length ||
      file.page_ids.some((id) => typeof id !== "string" || !id || id.length > 500) ||
      new Set(file.page_ids).size !== file.page_ids.length) throw Error("invalid page_paste_registration.v1");
  return { schema: PAGE_PASTE_REGISTRATION, batch_id: file.batch_id, page_ids: file.page_ids };
}

export interface PagePastePin { id: number; sha256: string }

/** SQL over proposal alias p. Keep enrolled proposals active for the ordinary reference export. */
export const OUTSIDE_PAGE_PASTE = "NOT EXISTS (SELECT 1 FROM page_paste_pages pp WHERE pp.item_id = p.item_id)";

/** Verify every pin and its index, and that the active pass-1 set has not gained lines. Alias pp. */
export const PINNED_PAGE_MATCHES = `NOT EXISTS (
    SELECT 1 FROM json_each(pp.line_pins_json) j LEFT JOIN proposals p
      ON p.id = json_extract(j.value, '$.id') AND p.item_id = pp.item_id AND p.batch_id = pp.batch_id
      AND p.active = 1 AND ${PASS1_SQL}
      AND p.content_sha256 = json_extract(j.value, '$.sha256')
      AND json_extract(p.payload_json, '$.line_index') = CAST(j.key AS INTEGER)
    WHERE p.id IS NULL
  ) AND json_array_length(pp.line_pins_json) = (
    SELECT COUNT(*) FROM proposals p WHERE p.item_id = pp.item_id AND p.batch_id = pp.batch_id
      AND p.active = 1 AND ${PASS1_SQL}
  )`;
