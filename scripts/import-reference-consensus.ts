import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs, str, target } from "./lib/args";
import { checkWriteBudget } from "./lib/d1budget";
import {
  liveReferenceSql, matchReferenceRows, readReferencePlan, referenceActivateSql, referenceStageSql, type LiveReferenceLine,
} from "./lib/reference-consensus-import";
import { lit } from "./lib/sql";
import { d1File, d1Query, loadCredentials } from "./lib/wrangler";

type Stored = { proposal_id: number; item_id: number; proposal_sha256: string; crop_key: string; page_key: string;
  line_box: string; lane: string; position: number };
type Run = { projection_sha256: string; ratification_sha256: string; items_sha256: string; rows_expected: number; active: number };
const { flags } = parseArgs(process.argv.slice(2));

async function main() {
  const destination = target(flags);
  const apply = flags.apply === true;
  const ratification = str(flags, "ratification");
  const privateInput = (path: string) => {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("input must be a private file");
    return readFileSync(path);
  };
  const plan = readReferencePlan(privateInput(str(flags, "projection")), privateInput(str(flags, "freeze")), privateInput(ratification),
    str(flags, "ratification-sha256"), str(flags, "items-sha256"));
  const reviewer = str(flags, "reviewer");
  if (!/^rv_[a-f0-9]{8}$/.test(reviewer)) throw new Error("use an existing reviewer id");
  const readLive = () => d1Query<LiveReferenceLine>(destination, liveReferenceSql(plan, reviewer))[0] ?? [];
  const run = () => d1Query<Run>(destination,
    `SELECT projection_sha256,ratification_sha256,items_sha256,rows_expected,active FROM reference_consensus_runs WHERE batch_id=${lit(plan.batch)}`)[0]?.[0];
  const before = matchReferenceRows(plan, readLive());
  const exists = run();
  if (exists && (exists.projection_sha256 !== plan.projectionPin || exists.ratification_sha256 !== plan.approvalPin ||
      exists.items_sha256 !== plan.itemsPin || exists.rows_expected !== before.length)) throw new Error("a different projection already owns the batch");

  const checkStage = (rows: typeof before) => {
    const staged = d1Query<Stored>(destination, `SELECT proposal_id,item_id,proposal_sha256,crop_key,page_key,line_box,lane,position
      FROM reference_consensus_lines WHERE projection_sha256=${lit(plan.projectionPin)}`)[0] ?? [];
    const byId = new Map(staged.map(r => [r.proposal_id, r]));
    if (staged.length !== rows.length || rows.some(x => {
      const r = byId.get(x.db.id);
      return !r || r.item_id !== x.db.item_id || r.proposal_sha256 !== x.db.sha || r.crop_key !== x.db.crop ||
        r.page_key !== x.db.page || r.line_box !== x.db.box || r.lane !== x.lane || r.position !== x.position;
    })) throw new Error("staged row readback differs from ratification");
  };

  if (apply && !exists?.active) {
    if (destination === "production") {
      const snapshot = str(flags, "backup");
      const stat = statSync(snapshot);
      if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o077) !== 0) throw new Error("production backup must be private");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(snapshot)) hash.update(chunk);
      if (hash.digest("hex") !== str(flags, "backup-sha256")) throw new Error("production backup pin differs");
      const creds = loadCredentials();
      for (const key of ["D1_DAILY_WRITE_BUDGET", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
        if (creds[key]) process.env[key] = creds[key];
      }
      await checkWriteBudget(destination, before.length * 4 + 8, {});
    }
    const scratch = mkdtempSync(join(dirname(ratification), ".reference-consensus-"));
    const stage = join(scratch, "stage.sql");
    try {
      writeFileSync(stage, referenceStageSql(plan, before), { mode: 0o600, flag: "wx" });
      d1File(destination, stage);
    } finally {
      try { unlinkSync(stage); } finally { rmdirSync(scratch); }
    }
    checkStage(matchReferenceRows(plan, readLive()));
    // The last statement activates the complete stage only while the exact live media and source still match.
    d1Query(destination, referenceActivateSql(plan, reviewer));
    if (run()?.active !== 1) throw new Error("staged rows were not activated");
  }

  const active = run()?.active === 1;
  const live = readLive();
  const current = matchReferenceRows(plan, live);
  if (active) checkStage(current);
  console.log(JSON.stringify({
    active, projection_sha256: plan.projectionPin, scoped_lines: current.length,
    current_human: current.filter(x => x.db.human).length,
    outside_scope_current_human: live.length - current.length,
    untouched_auto_accepts: current.filter(x => x.lane === "accepted" && !x.db.human).length,
    ordinary_pending: current.filter(x => x.lane === "ordinary" && !x.db.human && !x.db.skipped).length,
    blind_typing_pending: current.filter(x => x.lane === "audit" && !x.db.human && !x.db.skipped).length,
    skipped: current.filter(x => x.lane !== "accepted" && x.db.skipped && !x.db.human).length,
    pending_page_checks: new Set(live.filter(x => !x.page_complete).map(x => x.item_id)).size,
  }));
}

// Avoid CLI exception output containing private identifiers, SQL or OCR text.
main().catch(e => {
  const message = e instanceof SyntaxError || e instanceof TypeError ? "Invalid private import input." :
    e instanceof Error ? e.message : "Private import failed.";
  console.error(message.startsWith("wrangler") || message.includes("SQL") || message.includes("private-ref-")
    ? "Private D1 request failed. Verify the local readback." : message);
  process.exitCode = 1;
});
