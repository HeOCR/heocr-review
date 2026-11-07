import type { TaskImporter } from "./import";
import { lineVerifyImporter } from "./line_verify/importer";
import { referenceAuditImporter } from "./reference_audit/importer";

const IMPORTERS: Record<string, TaskImporter> = {
  [referenceAuditImporter.taskType]: referenceAuditImporter,
  [lineVerifyImporter.taskType]: lineVerifyImporter,
};

export function importer(taskType: string): TaskImporter | undefined {
  return Object.prototype.hasOwnProperty.call(IMPORTERS, taskType) ? IMPORTERS[taskType] : undefined;
}
