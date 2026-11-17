/**
 * Read-only: list the mid-century pages the maintainer has confirmed or rejected, for the volunteer import
 * (maintainer_decided.json, midcentury_maintainer_decided.v1). Those pages keep his references and are never
 * queued for volunteers (heocr-restricted-eval preregistration/midcentury_volunteers_2026-11-18, §1).
 *
 *   npm run maintainer-decided -- --out <dir> [--target local|preview|production]
 *
 * It runs one SELECT and writes page keys only: no decision content, no reviewer id.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAINTAINER_BATCH_ID, MAINTAINER_DECIDED_SCHEMA, MAINTAINER_FILE } from "../src/tasks/line_consensus/schema";
import { parseArgs, str, target } from "./lib/args";
import { inline } from "./lib/sql";
import { d1Query } from "./lib/wrangler";

/** First-pass pages (not the blind second pass) with a current confirm or reject on their current content. */
export const DECIDED_SQL = `SELECT DISTINCT i.external_id AS page_key FROM decisions d
  JOIN proposals p ON p.id = d.proposal_id JOIN items i ON i.id = p.item_id
  WHERE p.batch_id = ?1 AND p.active = 1 AND p.external_id NOT LIKE '%@pass2'
    AND d.superseded_at IS NULL AND d.proposal_sha256 = p.content_sha256 AND d.value IN ('confirm', 'reject')
  ORDER BY i.external_id`;

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const t = target(flags);
  const out = resolve(str(flags, "out"));
  const exportedAt = new Date().toISOString();
  const rows = d1Query<{ page_key: string }>(t, inline(DECIDED_SQL, MAINTAINER_BATCH_ID))[0] ?? [];
  const file = { schema: MAINTAINER_DECIDED_SCHEMA, batch_id: MAINTAINER_BATCH_ID, exported_at: exportedAt, target: t, pages: rows.map((r) => r.page_key) };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, MAINTAINER_FILE), JSON.stringify(file, null, 1) + "\n");
  console.log(JSON.stringify({ target: t, exported_at: exportedAt, pages: file.pages.length, out: join(out, MAINTAINER_FILE) }));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
