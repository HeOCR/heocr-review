/**
 * Read or change a batch's settings (migrations/0006_batch_settings.sql), which an import never touches.
 *
 *   npm run batch-setting -- --batch <id> [--target local|production [--yes-production]]
 *   npm run batch-setting -- --batch <id> --pass2-reviewer same|other --by <who> [--target ...]
 *   npm run batch-setting -- --batch <id> --two-typings-groups <group,group|none> --by <who> [--target ...]
 *   npm run batch-setting -- --batch <id> --resolution single|volunteer_v1|volunteer_v1_1 --by <who> [--target ...]
 *   npm run batch-setting -- --batch <id> --pointed-books drop|keep --by <who> [--target ...]
 *
 * pass2_reviewer (line_verify only): who gets a line's blind second pass. 'same' (the default): the reviewer who
 * answered pass 1, 24 hours later (intra-rater). 'other': only a reviewer who never decided the line's pass 1, 24
 * hours after another reviewer's answer (inter-rater; heocr-eval: switch it on once volunteers review the batch).
 * Changing it affects only lines not yet served; decisions already made keep their same_reviewer in the export.
 *
 * two_typings_groups (line_verify items v1.2 only; migrations/0007_two_typings.sql): the book groups whose typed lines
 * need a second independent typing (heocr-eval's registered fallback: over 5% word disagreement in the blind sample).
 * "none" clears it. Each group must be a book_group of the batch's pages.
 *
 * resolution (line_verify only; migrations/0009_volunteer_resolution.sql, 0010_phist_gold.sql): 'single' (the default),
 * 'volunteer_v1', or 'volunteer_v1_1' (volunteer_v1 plus the P-hist gold gate, docs/specs/line_verify_phist_gold_v1_1.md)
 * (docs/specs/line_verify_volunteer_resolution_v1.md: two counted decisions per line, routed in the app). Switch it
 * before the batch's first decision: lines decided under 'single' have no verify_votes rows.
 */
import { PASS2_REVIEWERS } from "../src/tasks/line_verify/schema";
import { parseArgs, str, target } from "./lib/args";
import { inline } from "./lib/sql";
import { d1Query } from "./lib/wrangler";

export const READ_SQL = `SELECT b.id, b.task_type, json_extract(b.source_json, '$.schema_version') AS schema_version,
  COALESCE(s.pass2_reviewer, 'same') AS pass2_reviewer, s.updated_at, s.updated_by,
  COALESCE(s.two_typings_groups, '[]') AS two_typings_groups, s.two_typings_set_at,
  COALESCE(s.pointed_books, 'drop') AS pointed_books
  FROM batches b LEFT JOIN batch_settings s ON s.batch_id = b.id WHERE b.id = ?1`;

/** The batch's book groups (v1.2 pages). */
export const GROUPS_SQL = `SELECT DISTINCT json_extract(payload_json, '$.book_group') AS g FROM items
  WHERE batch_id = ?1 AND json_extract(payload_json, '$.book_group') IS NOT NULL ORDER BY g`;

export const RESOLUTIONS = ["single", "volunteer_v1", "volunteer_v1_1"] as const;

/**
 * pointed_books (line_verify only; migrations/0011_pointed_books.sql): 'drop' (the default), a "print has niqqud"
 * mark by the admin or a counting reviewer takes the rest of the book out of the batch; 'keep' turns that off.
 */
export const POINTED_BOOKS = ["drop", "keep"] as const;
export const UPSERT_POINTED_SQL = `INSERT INTO batch_settings (batch_id, updated_at, updated_by, pointed_books) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (batch_id) DO UPDATE SET pointed_books = excluded.pointed_books, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

export function pointedBooksProblem(row: Row | undefined, value: string, by: string): string | null {
  if (!row) return "no such batch";
  if (row.task_type !== "line_verify") return `pointed_books applies to line_verify batches only (this one is ${row.task_type})`;
  if (!(POINTED_BOOKS as readonly string[]).includes(value)) return `--pointed-books must be one of ${POINTED_BOOKS.join(", ")}`;
  if (!by.trim()) return "--by must say who changes it";
  return null;
}

/** Only the resolution column changes; a new row starts with the other defaults. */
export const UPSERT_RESOLUTION_SQL = `INSERT INTO batch_settings (batch_id, updated_at, updated_by, resolution) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (batch_id) DO UPDATE SET resolution = excluded.resolution, updated_by = excluded.updated_by`;

/** Why a resolution change is refused (null: allowed). Switching needs a batch with no decision yet. */
export function resolutionProblem(row: Row | undefined, value: string, decisions: number, by: string): string | null {
  if (!row) return "no such batch";
  if (row.task_type !== "line_verify") return `resolution applies to line_verify batches only (this one is ${row.task_type})`;
  if (!(RESOLUTIONS as readonly string[]).includes(value)) return `--resolution must be one of ${RESOLUTIONS.join(", ")}`;
  if (decisions > 0) return `the batch already has ${decisions} decisions: switch resolution before its first decision`;
  if (!by.trim()) return "--by must say who changes it";
  return null;
}

/** Only the two-typings columns change; a new row starts with the pass2_reviewer default. */
export const UPSERT_TWO_SQL = `INSERT INTO batch_settings (batch_id, updated_at, updated_by, two_typings_groups, two_typings_set_at)
  VALUES (?1, ?2, ?3, ?4, ?2)
  ON CONFLICT (batch_id) DO UPDATE SET two_typings_groups = excluded.two_typings_groups, two_typings_set_at = excluded.two_typings_set_at, updated_by = excluded.updated_by`;

export const UPSERT_SQL = `INSERT INTO batch_settings (batch_id, pass2_reviewer, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT (batch_id) DO UPDATE SET pass2_reviewer = excluded.pass2_reviewer, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

type Row = {
  id: string;
  task_type: string;
  schema_version?: string | null;
  pass2_reviewer: string;
  updated_at: string | null;
  updated_by: string | null;
  two_typings_groups?: string;
  two_typings_set_at?: string | null;
  pointed_books?: string;
};

/** The groups a --two-typings-groups value names ("none": no group), or why it is refused. */
export function twoTypingsProblem(row: Row | undefined, value: string, groups: string[], by: string): { groups: string[] } | { problem: string } {
  if (!row) return { problem: "no such batch" };
  if (row.task_type !== "line_verify" || row.schema_version !== "line_verify_items.v1.2") {
    return { problem: "two_typings_groups applies to line_verify_items.v1.2 batches only" };
  }
  if (!by.trim()) return { problem: "--by must say who changes it" };
  const want = value === "none" ? [] : [...new Set(value.split(",").map((g) => g.trim()).filter(Boolean))].sort();
  if (value !== "none" && !want.length) return { problem: '--two-typings-groups needs group ids, or "none"' };
  const unknown = want.filter((g) => !groups.includes(g));
  if (unknown.length) return { problem: `not book groups of this batch: ${unknown.join(", ")} (it has ${groups.join(", ") || "none"})` };
  return { groups: want };
}

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
  if (typeof flags.resolution === "string") {
    const [n] = d1Query<{ n: number }>(t, inline("SELECT COUNT(*) AS n FROM decisions d JOIN proposals p ON p.id = d.proposal_id WHERE p.batch_id = ?1", batchId))[0]!;
    const problem = resolutionProblem(before, flags.resolution, n!.n, str(flags, "by", ""));
    if (problem) throw new Error(problem);
    d1Query(t, inline(UPSERT_RESOLUTION_SQL, batchId, new Date().toISOString(), str(flags, "by"), flags.resolution));
    console.log(JSON.stringify({ target: t, batch: batchId, resolution: flags.resolution }));
    return;
  }
  if (typeof flags["pointed-books"] === "string") {
    const problem = pointedBooksProblem(before, flags["pointed-books"], str(flags, "by", ""));
    if (problem) throw new Error(problem);
    d1Query(t, inline(UPSERT_POINTED_SQL, batchId, new Date().toISOString(), str(flags, "by"), flags["pointed-books"]));
    console.log(JSON.stringify({ target: t, batch: batchId, before: before!.pointed_books, after: read()?.pointed_books }));
    return;
  }
  if (typeof flags["two-typings-groups"] === "string") {
    const groups = d1Query<{ g: string }>(t, inline(GROUPS_SQL, batchId))[0]!.map((r) => r.g);
    const res = twoTypingsProblem(before, flags["two-typings-groups"], groups, str(flags, "by", ""));
    if ("problem" in res) throw new Error(res.problem);
    d1Query(t, inline(UPSERT_TWO_SQL, batchId, new Date().toISOString(), str(flags, "by"), JSON.stringify(res.groups)));
    console.log(JSON.stringify({ target: t, batch: batchId, before: before!.two_typings_groups, after: read()?.two_typings_groups }));
    return;
  }
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
