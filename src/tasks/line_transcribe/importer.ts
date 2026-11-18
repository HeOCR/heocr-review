/**
 * Import the H transcription batch: the registered box file h_line_items_v1.json with its pages/. Every box is a
 * line to transcribe; a page is an item, a line a proposal (category = stratum, confidence = eval set), ranked in
 * file order (pages, then lines in reading order). No text of any kind comes in.
 */
import type { ImportItem, ImportProposal, TaskImporter } from "../import";
import { boxes, initialStateSql } from "../line_consensus/importer";
import { TASK_TYPE_ID, type LineTranscribePayload, type LineTranscribeSource } from "./index";
import { GATE_BATCH_ID, H_BATCH_ID, H_LINE_ITEMS_FILE, REGISTERED_SHA256, hLineItemsProblems, type HLineItemsFile, type HPage } from "./schema";

const imageName = (p: HPage) => `pages/${p.image.split("/").pop()!}`;

/** Volunteers are not told a page is a seen writer's (it would point them to the published text). */
const STRATUM_TITLE: Record<string, string> = { other_hebrew_script: " · כתב עברי, שפה אחרת" };

export const lineTranscribeImporter: TaskImporter = {
  taskType: TASK_TYPE_ID,
  bundleFile: H_LINE_ITEMS_FILE,
  registeredSha256: REGISTERED_SHA256,
  // Until eval registers the box file (amendment 3), every box file is refused.
  mustBeRegistered: [H_LINE_ITEMS_FILE],
  fullPages: true,
  afterImportSql: (batchId: string, importedAt: string) => [initialStateSql(batchId, importedAt)],

  problems(raw: unknown): string[] {
    return hLineItemsProblems(raw);
  },

  bundle(raw: unknown, _sidecars?: Record<string, unknown>, fileSha256?: Record<string, string>) {
    const file = raw as HLineItemsFile;
    const items: ImportItem[] = [];
    const proposals: ImportProposal[] = [];
    for (const p of file.pages) {
      items.push({
        externalId: p.page_key,
        title: `${p.page_key}${STRATUM_TITLE[p.stratum] ?? ""}`,
        payload: { page_key: p.page_key, eval_set: p.eval_set, stratum: p.stratum, image_sha256: p.image_sha256 },
        imageStem: null,
        bundleImage: { path: imageName(p), sha256: p.image_sha256, width: p.image_size[0], height: p.image_size[1] },
      });
      for (const line of p.lines) {
        const b = boxes(line.box, p.image_size);
        const payload: LineTranscribePayload = {
          page_key: p.page_key,
          i: line.i,
          prefill: "",
          box_status: "matched",
          gold: null,
          eval_set: p.eval_set,
          stratum: p.stratum,
          languages: p.languages,
          hand_id: p.hand_id,
          attribution: p.attribution,
          license_expression: p.license_expression,
          image_sha256: p.image_sha256,
          order: proposals.length,
          page_box: b.pageBox,
          context_box: b.contextBox,
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
      sources: { [H_LINE_ITEMS_FILE]: fileSha256?.[H_LINE_ITEMS_FILE] ?? null, ...file.manifests },
    };
    return {
      batch: { id: H_BATCH_ID, taskType: TASK_TYPE_ID, title: "תעתוק כתבי יד / Handwriting transcription", source: source as unknown as Record<string, unknown> },
      items,
      proposals,
    };
  },
};
