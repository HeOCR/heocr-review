/** Count from, and optionally apply against, a private D1 export. Logs contain counts only. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs, str, target } from "./lib/args";
import { checkWriteBudget } from "./lib/d1budget";
import { commaDraftsSql, commaReadbackSql, guardedCommaUpdate, planCommaBackfill, queueKey, type CommaDraftRow } from "./lib/draft-comma-backfill";
import { punctuationSwitches } from "./lib/draft-comma-spacing";
import { d1File, d1Query, loadCredentials } from "./lib/wrangler";

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const destination = target(flags);
  const marks = punctuationSwitches(flags);
  const apply = flags.apply === true;
  const path = realpathSync(str(flags, "backup"));
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if ((statSync(path).mode & 0o777) !== 0o600 || str(flags, "backup-sha256") !== sha) {
    throw new Error("backup must be mode 0600 and match the supplied SHA-256");
  }
  if (apply && destination === "production" && dirname(path) !== join(homedir(), ".config", "heocr", "d1-exports")) {
    throw new Error("production apply requires an export from the private D1 export directory");
  }
  const db = new DatabaseSync(":memory:");
  db.exec(bytes.toString("utf8"));
  const { queues, updates } = planCommaBackfill(db.prepare(commaDraftsSql).all() as unknown as CommaDraftRow[], marks);
  db.close();
  const estimate = updates.length;
  console.log(JSON.stringify({ backup_sha256: sha, write_estimate: estimate, marks: marks.length ? marks : [","], queues }));

  if (destination === "production") {
    const credentials = loadCredentials();
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DAILY_WRITE_BUDGET"]) {
      if (credentials[key]) process.env[key] = credentials[key];
    }
  }
  await checkWriteBudget(destination, estimate, {});
  if (!apply) return;
  const actual = Object.fromEntries(Object.keys(queues).map(key => [key, 0]));
  if (updates.length) {
    const dir = mkdtempSync(join(tmpdir(), "heocr-comma-spacing-"));
    const sql = join(dir, "apply.sql");
    try {
      writeFileSync(sql, updates.map(guardedCommaUpdate).join("\n") + "\n", { flag: "wx", mode: 0o600 });
      try { d1File(destination, sql); } catch { throw new Error("backfill write failed"); }
    } finally {
      unlinkSync(sql);
      rmdirSync(dir);
    }
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      const rows = d1Query<{ id: number; content_sha256: string; original_sha: string }>(
        destination, commaReadbackSql(chunk.map(u => u.row.id), marks.length > 0),
      )[0] ?? [];
      const readback = new Map(rows.map(row => [row.id, row]));
      for (const update of chunk) {
        const row = readback.get(update.row.id);
        if (row?.content_sha256 === update.contentSha256 && row.original_sha === update.row.content_sha256) {
          const key = queueKey(update.row);
          actual[key] = (actual[key] ?? 0) + 1;
        }
      }
    }
  }
  console.log(JSON.stringify({ applied: actual, guarded_or_changed: estimate - Object.values(actual).reduce((a, b) => a + b, 0) }));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : "";
  const allowed = /^(backup must|production apply requires|backfill write failed|this import would write|cannot check the D1 write budget|--(?:period|semicolon|colon|question-mark|exclamation-mark) does not take a value)/;
  console.error(allowed.test(message) ? message : "Comma-spacing operation failed. Check protected inputs locally.");
  process.exitCode = 1;
});
