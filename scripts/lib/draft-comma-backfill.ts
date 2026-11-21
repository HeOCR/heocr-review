import { ALLOWED_REFERENCE_PROPOSAL } from "../../src/tasks/restricted_reference";
import { TRIAGEABLE_SQL } from "../../src/tasks/line_verify/triage";
import { COMMA_AUDIT, commaSpacingRevision, draftTexts, normalizeDraftCommas } from "./draft-comma-spacing";
import { lit } from "./sql";

const decided = "EXISTS (SELECT 1 FROM decisions WHERE proposal_id=p.id)";
const edited = "EXISTS (SELECT 1 FROM drafts WHERE proposal_id=p.id)";
const assigned = "EXISTS (SELECT 1 FROM assignments WHERE proposal_id=p.id)";
const planted = "EXISTS (SELECT 1 FROM triage_plants WHERE proposal_id=p.id)";
const open = "EXISTS (SELECT 1 FROM batches WHERE id=p.batch_id AND status='open')";
const accessible = `p.active=1 AND ${open} AND ${ALLOWED_REFERENCE_PROPOSAL}`;

export const commaDraftsSql = `SELECT p.id, p.batch_id, b.task_type, p.payload_json, p.content_sha256, p.gate_kind,
  CASE WHEN s.mode='triage' THEN CASE WHEN ${TRIAGEABLE_SQL} THEN 'triage' ELSE 'desktop' END
       WHEN p.gate_kind='after_confirm' THEN 'blind' ELSE 'review' END AS queue,
  (${decided} OR ${edited}) AS reviewed, ${assigned} AS served, ${planted} AS planted
  FROM proposals p JOIN batches b ON b.id=p.batch_id LEFT JOIN batch_settings s ON s.batch_id=b.id
  WHERE ${accessible} AND b.task_type IN ('line_verify','line_consensus','page_review','reference_audit')
  ORDER BY p.batch_id,p.id`;

export interface CommaDraftRow {
  id: number;
  batch_id: string;
  task_type: string;
  queue: string;
  payload_json: string;
  content_sha256: string;
  gate_kind: string | null;
  reviewed: number;
  served: number;
  planted: number;
}

interface Update {
  row: CommaDraftRow;
  payload: Record<string, unknown>;
  contentSha256: string;
}

const newCounts = () => ({
  changes: 0, changed_lines: 0, reviewed: 0, already_served: 0, registered_plant: 0,
  other_punctuation: { ".": 0, ";": 0, ":": 0, "?": 0, "!": 0 },
});
type Counts = ReturnType<typeof newCounts>;

export function planCommaBackfill(rows: CommaDraftRow[]) {
  const queues = new Map<string, Counts>();
  const updates: Update[] = [];
  for (const row of rows) {
    const key = queueKey(row);
    const counts = queues.get(key) ?? newCounts();
    queues.set(key, counts);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const texts = draftTexts(row.task_type, payload);
    if (!row.reviewed) {
      for (const text of texts) {
        const marks = new Set([...text.matchAll(/[^\S\r\n]+([.;:?!])/gu)].map(m => m[1] as keyof Counts["other_punctuation"]));
        for (const mark of marks) counts.other_punctuation[mark]++;
      }
    }
    const correction = commaSpacingRevision(row.task_type, payload, row.content_sha256);
    if (!correction) continue;
    if (row.reviewed) counts.reviewed++;
    else if (row.planted) counts.registered_plant++;
    else if (row.served) counts.already_served++;
    else {
      counts.changes++;
      counts.changed_lines += texts.filter(text => text !== normalizeDraftCommas(text)).length;
      updates.push({ row, ...correction });
    }
  }
  return { queues: Object.fromEntries(queues), updates };
}

export const queueKey = (row: Pick<CommaDraftRow, "batch_id" | "queue">) => `${row.batch_id}/${row.queue}`;

export function guardedCommaUpdate({ row, payload, contentSha256 }: Update): string {
  return `UPDATE proposals AS p SET payload_json=${lit(JSON.stringify(payload))}, content_sha256=${lit(contentSha256)}
    WHERE p.id=${row.id} AND p.batch_id=${lit(row.batch_id)} AND p.content_sha256=${lit(row.content_sha256)}
      AND p.payload_json=${lit(row.payload_json)} AND ${accessible}
      AND NOT (${decided} OR ${edited} OR ${assigned} OR ${planted});`;
}

export const commaReadbackSql = (ids: number[]) => `SELECT id, content_sha256,
  json_extract(payload_json,'$.${COMMA_AUDIT}.content_sha256') original_sha
  FROM proposals WHERE id IN (${ids.join(",")})`;
