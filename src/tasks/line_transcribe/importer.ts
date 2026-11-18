/**
 * Import the H transcription batch: the registered box file h_line_items_v1.json, the two registered H manifests
 * (sidecars, at their HASH paths) and the page images at their HASH paths. Every box is a line to transcribe; a page
 * is an item, a line a proposal (category = stratum, confidence = eval set), ranked in file order (pages, then lines
 * in reading order). No text of any kind comes in.
 *
 * Held out of the queue: pages flagged no_hebrew_text (until eval rules on them, amendment 3) and pages with no box.
 */
import type { ImportItem, ImportProposal, TaskImporter } from "../import";
import { boxes, initialStateSql } from "../line_consensus/importer";
import { TASK_TYPE_ID, type LineTranscribePayload, type LineTranscribeSource } from "./index";
import {
  GATE_BATCH_ID,
  HELD_PAGE_FLAG,
  H_BATCH_ID,
  H_MANIFESTS,
  H_LINE_ITEMS_FILE,
  MANIFEST_FILES,
  REGISTERED_SHA256,
  hLineItemsProblems,
  manifestIndex,
  type HLineItemsFile,
} from "./schema";

/** Volunteers are not told a page is a seen writer's (it would point them to the published text). */
const STRATUM_TITLE: Record<string, string> = { other_hebrew_script: " · כתב עברי, שפה אחרת" };

/**
 * The band shown around a line: the whole width of the page, so a volunteer on the first piece of a split line sees
 * the rest of the row, and a line above and below.
 */
export function transcribeBoxes(box: [number, number, number, number], size: [number, number]) {
  const b = boxes(box, size);
  return { pageBox: b.pageBox, contextBox: [0, b.contextBox[1], 1, b.contextBox[3]] as [number, number, number, number] };
}

export const lineTranscribeImporter: TaskImporter = {
  taskType: TASK_TYPE_ID,
  bundleFile: H_LINE_ITEMS_FILE,
  sidecars: Object.values(MANIFEST_FILES),
  registeredSha256: { ...REGISTERED_SHA256, ...Object.fromEntries(Object.entries(MANIFEST_FILES).map(([set, f]) => [f, H_MANIFESTS[set]!])) },
  // The box file is refused until eval registers it (amendment 3); the manifests are registered (h_eval_v1, v1_1).
  mustBeRegistered: [H_LINE_ITEMS_FILE, ...Object.values(MANIFEST_FILES)],
  fullPages: true,
  afterImportSql: (batchId: string, importedAt: string) => [initialStateSql(batchId, importedAt)],

  problems(raw: unknown, sidecars?: Record<string, unknown>): string[] {
    return hLineItemsProblems(raw, sidecars);
  },

  bundle(raw: unknown, sidecars?: Record<string, unknown>, fileSha256?: Record<string, string>) {
    const file = raw as HLineItemsFile;
    const manifest = manifestIndex(sidecars);
    const items: ImportItem[] = [];
    const proposals: ImportProposal[] = [];
    const held: { page_key: string; reason: string }[] = [];
    for (const p of file.pages) {
      if (p.page_flag === HELD_PAGE_FLAG) {
        held.push({ page_key: p.page_key, reason: HELD_PAGE_FLAG });
        continue;
      }
      if (p.lines.length === 0) {
        held.push({ page_key: p.page_key, reason: "no_boxes" });
        continue;
      }
      const m = manifest.get(p.page_key)!;
      const pageBoxes = p.lines.map((l) => transcribeBoxes(l.box, p.image_size).pageBox);
      items.push({
        externalId: p.page_key,
        title: `${p.page_key}${STRATUM_TITLE[p.stratum] ?? ""}`,
        payload: { page_key: p.page_key, eval_set: p.eval_set, stratum: p.stratum, image_sha256: p.image_sha256, page_flag: p.page_flag },
        imageStem: null,
        bundleImage: { path: p.image, sha256: p.image_sha256, width: p.image_size[0], height: p.image_size[1] },
      });
      for (const line of p.lines) {
        const b = transcribeBoxes(line.box, p.image_size);
        const payload: LineTranscribePayload = {
          page_key: p.page_key,
          i: line.i,
          prefill: "",
          box_status: "matched",
          gold: null,
          eval_set: p.eval_set,
          stratum: p.stratum,
          languages: m.languages,
          // The holding institution only: no shelfmark, title or writer (a seen writer's name would point to the text).
          attribution: m.holding_institution ?? m.provider,
          license_expression: m.license_expression,
          image_sha256: p.image_sha256,
          order: proposals.length,
          box: line.box,
          page_box: b.pageBox,
          context_box: b.contextBox,
          page_boxes: pageBoxes,
        };
        const externalId = `${p.page_key}#l${line.i}`;
        proposals.push({
          externalId,
          itemExternalId: p.page_key,
          category: p.stratum,
          confidence: p.eval_set,
          rank: payload.order,
          payload: payload as unknown as Record<string, unknown>,
          pageBox: b.pageBox,
          contextBox: b.contextBox,
          // A transcription is of this scan and this box.
          contentKey: { external_id: externalId, image_sha256: p.image_sha256, box: line.box },
        });
      }
    }
    const source: LineTranscribeSource = {
      schema_version: file.schema,
      batch_id: H_BATCH_ID,
      gate_batch_id: GATE_BATCH_ID,
      sources: Object.fromEntries([H_LINE_ITEMS_FILE, ...Object.values(MANIFEST_FILES)].map((f) => [f, fileSha256?.[f] ?? null])),
      held_pages: held,
    };
    return {
      batch: { id: H_BATCH_ID, taskType: TASK_TYPE_ID, title: "תעתוק כתבי יד / Handwriting transcription", source: source as unknown as Record<string, unknown> },
      items,
      proposals,
    };
  },
};
