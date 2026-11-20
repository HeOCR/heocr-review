/** Reserve an eval-approved set of existing pages. Only the assigned admin's UI writes the text. */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PAGE_PASTE_REGISTRATION, PINNED_PAGE_MATCHES, parsePagePasteRegistration, type PagePastePin } from "../src/tasks/line_verify/page_paste";
import { PASS1_SQL } from "../src/tasks/line_verify/pagerecords";
import { parseArgs, str, target } from "./lib/args";
import { assertOpenSource } from "./lib/guard";
import { checkWriteBudget } from "./lib/d1budget";
import { lit } from "./lib/sql";
import { d1File, d1Migrate, d1Query, loadCredentials } from "./lib/wrangler";

interface PageRow { id: number; external_id: string; has_image: number }
interface LineRow { id: number; item_id: number; sha256: string; line_index: number | null }

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const t = target(flags);
  const file = resolve(str(flags, "page-list"));
  assertOpenSource(file);
  // No eval source or held-out data is needed. This input is the IDs-only list forwarded by eval.
  const restricted = /(?:^|\/)(?:eval_refs|heocr-restricted-eval|preregistration|test)(?:\/|$)|(?:^|\/)runs\/[^/]*test|(?:^|\/)scans\/(?:ps_v1|nq1)(?:\/|$)/i;
  if ([file, realpathSync(file)].some((path) => restricted.test(path))) throw Error("use the forwarded registration outside restricted areas");
  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== str(flags, "sha256")) throw Error("page registration SHA-256 does not match the pinned hash");
  const registration = parsePagePasteRegistration(JSON.parse(bytes.toString("utf8")));
  if (t === "production" && registration.batch_id !== "h_eval_v1_lines") throw Error("production page paste is limited to h_eval_v1_lines");
  const reviewer = str(flags, "reviewer");
  if (!/^rv_[a-f0-9]{8}$/.test(reviewer)) throw Error("--reviewer must be the assigned admin's reviewer pseudonym");
  if (t === "production") {
    const settings = JSON.parse(readFileSync(join(homedir(), ".config/heocr/heocr-review.secrets.json"), "utf8")) as { ADMIN_REVIEWER_IDS?: string };
    if (!settings.ADMIN_REVIEWER_IDS?.split(",").some((id) => id.trim() === reviewer)) throw Error("the assigned reviewer is not configured as a production admin");
  }
  if (t === "local") d1Migrate(t);
  const b = lit(registration.batch_id);
  const [batch] = d1Query(t, `SELECT 1 FROM batches b JOIN batch_settings s ON s.batch_id = b.id
    WHERE b.id = ${b} AND b.task_type = 'line_verify' AND b.status = 'open' AND s.mode = 'triage'`)[0]!;
  if (!batch) throw Error("an open line_verify triage batch is required");
  if (!d1Query(t, `SELECT 1 FROM reviewers WHERE id = ${lit(reviewer)} AND blocked = 0`)[0]?.length) throw Error("reviewer is missing or blocked");
  if (d1Query(t, `SELECT 1 FROM page_paste_pages WHERE batch_id = ${b} LIMIT 1`)[0]?.length) throw Error("batch already has a page-paste registration");

  const externalIds = registration.page_ids.map(lit).join(", ");
  const pages = d1Query<PageRow>(t, `SELECT i.id, i.external_id,
    (json_extract(i.payload_json, '$.page_image') IS NOT NULL OR EXISTS (
      SELECT 1 FROM proposals p WHERE p.item_id = i.id AND p.active = 1 AND ${PASS1_SQL}
        AND json_extract(p.payload_json, '$.line_index') = 0 AND json_extract(p.media_json, '$.page') IS NOT NULL
    )) AS has_image FROM items i WHERE i.batch_id = ${b} AND i.external_id IN (${externalIds})`)[0]!;
  if (pages.length !== registration.page_ids.length || pages.some((page) => !page.has_image)) {
    throw Error("a registered page is missing or does not have full-page media");
  }
  const pageIds = pages.map((p) => p.id).join(", ");
  const lines = d1Query<LineRow>(t, `SELECT p.id, p.item_id, p.content_sha256 AS sha256,
    json_extract(p.payload_json, '$.line_index') AS line_index
    FROM proposals p WHERE p.batch_id = ${b} AND p.item_id IN (${pageIds}) AND p.active = 1 AND ${PASS1_SQL}
    ORDER BY p.item_id, line_index`)[0]!;
  const pins = new Map<number, PagePastePin[]>();
  for (const line of lines) {
    const page = pins.get(line.item_id) ?? [];
    if (line.line_index !== page.length) throw Error("a registered page's active pass-1 line indexes are not contiguous");
    page.push({ id: line.id, sha256: line.sha256 });
    pins.set(line.item_id, page);
  }
  if (pins.size !== pages.length) throw Error("a registered page has no pass-1 lines");
  const plantScope = `batch_id = ${b} AND proposal_id IN (SELECT id FROM proposals WHERE item_id IN (${pageIds}))`;
  const [plants] = d1Query<{ n: number }>(t, `SELECT COUNT(*) AS n FROM triage_plants WHERE ${plantScope} AND voided_at IS NULL`)[0]!;
  const dry = flags["dry-run"] === true;
  let voided: number | undefined;
  if (!dry) {
    if (t === "production") {
      const credentials = loadCredentials();
      for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DAILY_WRITE_BUDGET"]) {
        if (credentials[key]) process.env[key] = credentials[key];
      }
    }
    await checkWriteBudget(t, pages.length * 3 + plants!.n * 2, flags);
    const now = lit(new Date().toISOString());
    const rows = new Map(pages.map((p) => [p.external_id, p]));
    const sql = registration.page_ids.map((id, ordinal) => {
      const pageId = rows.get(id)!.id;
      const planned = `SELECT ${pageId} AS item_id, ${b} AS batch_id, ${lit(JSON.stringify(pins.get(pageId)))} AS line_pins_json`;
      // A concurrent mapping change makes the pin subquery NULL, which fails the NOT NULL constraint.
      return `INSERT INTO page_paste_pages (item_id, batch_id, reviewer_id, ordinal, line_pins_json, registration_sha256, registered_at)
        VALUES (${pageId}, ${b}, ${lit(reviewer)}, ${ordinal},
          (SELECT pp.line_pins_json FROM (${planned}) pp WHERE ${PINNED_PAGE_MATCHES}
            AND EXISTS (SELECT 1 FROM batches b JOIN batch_settings s ON s.batch_id = b.id
              WHERE b.id = pp.batch_id AND b.status = 'open' AND s.mode = 'triage')),
          ${lit(digest)}, ${now});`;
    });
    mkdirSync(".import", { recursive: true, mode: 0o700 });
    const folder = mkdtempSync(join(".import", "page-paste-"));
    const path = join(folder, "register.sql");
    try {
      writeFileSync(path, sql.join("\n"), { mode: 0o600 });
      d1File(t, path);
    } finally {
      unlinkSync(path);
      rmdirSync(folder);
    }
    const [stored] = d1Query<{ pages: number; remaining_plants: number; plants_voided: number }>(t, `SELECT
      (SELECT COUNT(*) FROM page_paste_pages WHERE batch_id = ${b} AND registration_sha256 = ${lit(digest)}) AS pages,
      (SELECT COUNT(*) FROM triage_plants WHERE ${plantScope} AND voided_at IS NULL) AS remaining_plants,
      (SELECT COUNT(*) FROM triage_plants WHERE ${plantScope} AND voided_at = ${now} AND void_reason = 'page_paste') AS plants_voided`)[0]!;
    if (stored?.pages !== pages.length || stored.remaining_plants !== 0) throw Error("registration readback did not pass");
    voided = stored.plants_voided;
  }
  console.log(JSON.stringify({ schema: PAGE_PASTE_REGISTRATION, batch: registration.batch_id, registration_sha256: digest,
    pages: pages.length, lines: lines.length, plants_to_void: plants!.n, plants_voided: voided, applied: !dry }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
