import { PAGE_PASTE_TRAIN } from "../../shared/page_paste_train";
import type { BatchRecord } from "../types";
import type { PixelBox, TrainingImage } from "./schema";

export const TRAIN_EXPORT_FILE = "page_paste_train.json";
export const TRAIN_EXPORT_SQL = `SELECT p.page_key, p.position, p.image_json, p.line_boxes_json,
  d.page_text, d.entered_count, d.alignment_mismatch, d.reviewer_id, d.terms_version, d.saved_at
  FROM page_paste_train_pages p LEFT JOIN page_paste_train_decisions d ON d.page_id = p.id
  WHERE p.batch_id = ?1 ORDER BY p.position`;

export interface TrainingExportRow {
  page_key: string;
  position: number;
  image_json: string;
  line_boxes_json: string;
  page_text: string | null;
  entered_count: number | null;
  alignment_mismatch: number | null;
  reviewer_id: string | null;
  terms_version: string | null;
  saved_at: string | null;
}

export function isTrainingPaste(batch: BatchRecord | null): batch is BatchRecord {
  return batch?.taskType === PAGE_PASTE_TRAIN && batch.source.split === "train";
}

export function trainingExport(batch: BatchRecord, rows: TrainingExportRow[], exportedAt: string) {
  return {
    counts: { pages: rows.length, completed: rows.filter((r) => r.saved_at !== null).length,
      alignment_mismatches: rows.filter((r) => r.alignment_mismatch === 1).length },
    file: {
      schema: "page_paste_train_transcriptions.v1", split: "train", batch_id: batch.id,
      source: batch.source.catalog, manifest_sha256: batch.source.manifest_sha256, exported_at: exportedAt,
      pages: rows.map((r) => {
        const lineBoxes = JSON.parse(r.line_boxes_json) as PixelBox[];
        return {
          page_id: r.page_key, position: r.position, image: JSON.parse(r.image_json) as TrainingImage,
          line_boxes: lineBoxes, detected_line_count: lineBoxes.length, page_text: r.page_text,
          entered_line_count: r.entered_count, alignment_mismatch: r.alignment_mismatch === null ? null : r.alignment_mismatch === 1,
          reviewer: r.reviewer_id, terms_version: r.terms_version, saved_at: r.saved_at,
        };
      }),
    },
  };
}
