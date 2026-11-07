import type { TaskImporter } from "./import";
import { referenceAuditImporter } from "./reference_audit/importer";

const IMPORTERS: Record<string, TaskImporter> = { [referenceAuditImporter.taskType]: referenceAuditImporter };

export function importer(taskType: string): TaskImporter | undefined {
  return Object.prototype.hasOwnProperty.call(IMPORTERS, taskType) ? IMPORTERS[taskType] : undefined;
}
