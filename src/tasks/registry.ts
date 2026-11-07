import { referenceAudit } from "./reference_audit";
import type { TaskType } from "./types";

/**
 * Every task type the app can serve. Planned: per-line language tags (Pinkas), silver-page confirmation
 * (Ben-Yehuda) and quality-3 second-review adjudication. Each adds a module here and, if it needs a new kind
 * of view, a renderer in src/web/views/.
 */
const TASK_TYPES: Record<string, TaskType> = {
  [referenceAudit.id]: referenceAudit,
};

export function taskType(id: string): TaskType | undefined {
  return Object.prototype.hasOwnProperty.call(TASK_TYPES, id) ? TASK_TYPES[id] : undefined;
}

export function taskTypeIds(): string[] {
  return Object.keys(TASK_TYPES);
}
