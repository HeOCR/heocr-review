/**
 * Read or change a batch's settings (migrations/0006_batch_settings.sql), which an import never touches.
 *
 *   npm run batch-setting -- --batch <id> [--target local|preview|production [--yes-production]]
 *   npm run batch-setting -- --batch <id> --pass2-reviewer same|other --by <who> [--target ...]
 *
 * pass2_reviewer (line_verify only): who gets a line's blind second pass. 'same' (the default): the reviewer who
 * answered pass 1, 24 hours later (intra-rater). 'other': only a reviewer who never decided the line's pass 1, 24
 * hours after another reviewer's answer (inter-rater; heocr-eval: switch it on once volunteers review the batch).
 * Changing it affects only lines not yet served; decisions already made keep their same_reviewer in the export.
 */
import { PASS2_REVIEWERS } from "../src/tasks/line_verify/schema";
import { parseArgs, str, target } from "./lib/args";
import { inline } from "./lib/sql";
import { d1Query } from "./lib/wrangler";

export const READ_SQL = `SELECT b.id, b.task_type, COALESCE(s.pass2_reviewer, 'same') AS pass2_reviewer, s.updated_at, s.updated_by
  FROM batches b LEFT JOIN batch_settings s ON s.batch_id = b.id WHERE b.id = ?1`;

export const UPSERT_SQL = `INSERT INTO batch_settings (batch_id, pass2_reviewer, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (batch_id) DO UPDATE SET pass2_reviewer = excluded.pass2_reviewer, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

type Row = { id: string; task_type: string; pass2_reviewer: string; updated_at: string | null; updated_by: string | null };

/** Why a pass2_reviewer change is refused (null: allowed). */
export function settingProblem(row: Row | undefined, value: string, by: string): string | null {
  if (!row) return "no such batch";
  if (!(PASS2_REVIEWERS as readonly string[]).includes(value)) return `--pass2-reviewer must be one of ${PASS2_REVIEWERS.join(", ")}`;
  if (row.task_type !== "line_verify") return `pass2_reviewer applies to line_verify batches only (this one is ${row.task_type})`;
  if (!by.trim()) return "--by must say who changes it";
  return null;
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const t = target(flags);
  const batchId = str(flags, "batch");
  const read = () => d1Query<Row>(t, inline(READ_SQL, batchId))[0]?.[0];
  const before = read();
  if (typeof flags["pass2-reviewer"] !== "string") {
    if (!before) throw new Error("no such batch");
    console.log(JSON.stringify({ target: t, ...before }));
    return;
  }
  const value = flags["pass2-reviewer"];
  const by = str(flags, "by", "");
  const problem = settingProblem(before, value, by);
  if (problem) throw new Error(problem);
  d1Query(t, inline(UPSERT_SQL, batchId, value, new Date().toISOString(), by));
  console.log(JSON.stringify({ target: t, batch: batchId, before: before!.pass2_reviewer, after: read()?.pass2_reviewer }));
}

if (process.argv[1]?.endsWith("batch-setting.ts")) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
