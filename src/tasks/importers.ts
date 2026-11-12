import type { TaskImporter } from "./import";
import { lineVerifyImporter } from "./line_verify/importer";
import { pageReviewImporter } from "./page_review/importer";
import { referenceAuditImporter } from "./reference_audit/importer";

const IMPORTERS: Record<string, TaskImporter> = {
  [referenceAuditImporter.taskType]: referenceAuditImporter,
  [lineVerifyImporter.taskType]: lineVerifyImporter,
  [pageReviewImporter.taskType]: pageReviewImporter,
};

export function importer(taskType: string): TaskImporter | undefined {
  return Object.prototype.hasOwnProperty.call(IMPORTERS, taskType) ? IMPORTERS[taskType] : undefined;
}
