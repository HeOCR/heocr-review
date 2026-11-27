/** Stage a closed, test-only line queue from a pinned offline manifest and byte-exact PNG crops. */
import { mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, str, target } from "./lib/args";
import { checkWriteBudget, estimateImportWrites } from "./lib/d1budget";
import { contentSha256 } from "./lib/importsql";
import { proofreadBundle, proofreadMedia, proofreadStageSql } from "./lib/reference-proofread-import";
import { accessFixture, readPrivateObjects } from "./lib/restricted-reference-objects";
import { lit } from "./lib/sql";
import { d1File, d1Query, loadCredentials } from "./lib/wrangler";

function outsideCheckout(path: string) {
  const rel = relative(resolve(import.meta.dirname, ".."), path);
  if (rel !== ".." && !rel.startsWith(".." + sep)) throw new Error("use a private path outside the checkout");
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const dest = target(flags);
  const manifest = realpathSync(str(flags, "manifest"));
  const cropRoot = realpathSync(str(flags, "crop-root"));
  outsideCheckout(manifest);
  outsideCheckout(cropRoot);
  const { bundle, queue, leaves, hard } = proofreadBundle(readFileSync(manifest), str(flags, "manifest-sha256"),
    str(flags, "batch"), str(flags, "title"));
  const mediaOut = typeof flags["media-out"] === "string" ? resolve(flags["media-out"]) : null;
  if (dest === "production" && mediaOut) throw new Error("prepare private media offline before production");
  if (mediaOut) {
    outsideCheckout(realpathSync(dirname(mediaOut)));
    mkdirSync(mediaOut, { mode: 0o700 });
    mkdirSync(join(mediaOut, bundle.batch.id), { mode: 0o700 });
  }
  const prepared = await proofreadMedia({ bundle, queue, leaves, hard }, cropRoot,
    mediaOut ? (key, bytes) => writeFileSync(join(mediaOut, key), bytes, { flag: "wx", mode: 0o600 }) : undefined);
  if (mediaOut) writeFileSync(join(mediaOut, accessFixture.key), accessFixture.text, { flag: "wx", mode: 0o600 });
  const counts = {
    items: queue.length, leaves, regions: bundle.items.length, hard, private_objects: prepared.objects.size,
    first_answers_estimated_rows_written: queue.length * 4,
    estimated_rows_written: estimateImportWrites({ items: bundle.items.length, proposals: queue.length, existingProposals: 0 }) +
      bundle.items.length * 3 + 8,
  };
  if (flags["dry-run"] === true) {
    console.log(JSON.stringify({ ...counts, production_written: false }));
    return;
  }
  const b = lit(bundle.batch.id);
  const existing = d1Query(dest, `SELECT id FROM batches WHERE id=${b}`)[0]?.length;
  if (existing) throw new Error("the batch id already exists; inspect the existing stage without re-importing");
  if (dest === "production") {
    const credentials = loadCredentials();
    for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "D1_DAILY_WRITE_BUDGET"]) {
      if (credentials[key]) process.env[key] = credentials[key];
    }
    // Keep headroom for a same-day full pass, including one supersession per line.
    await checkWriteBudget(dest, counts.estimated_rows_written + 2 + queue.length * 12, {});
    const { objects } = await readPrivateObjects(bundle.batch.id, credentials);
    const live = new Map(objects.map(row => [row.key, row]));
    if (live.size !== prepared.objects.size || [...prepared.objects].some(([key, row]) =>
      live.get(key)?.size !== row.size || live.get(key)?.etag !== row.etag)) {
      throw new Error("production R2 does not match the exact private crop inventory");
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "reference-proofread-"));
  try {
    const file = join(scratch, "stage.sql");
    writeFileSync(file, proofreadStageSql(bundle, prepared.media, new Date().toISOString()), { flag: "wx", mode: 0o600 });
    // Wrangler failures can echo SQL literals. The command reports a fixed error in that case.
    try { d1File(dest, file); } catch { throw new Error("protected D1 staging failed; inspect closed-stage counts"); }
  } finally {
    rmSync(join(scratch, "stage.sql"), { force: true });
    rmdirSync(scratch);
  }

  const [batches, items, lines] = d1Query<{
    id: string; ok: number; rank: number; content: string; parent: string; crop: string;
  }>(dest, `SELECT id, status='closed' AND restricted_reference=1 AND source_json=${lit(JSON.stringify(bundle.batch.source))} AS ok
    FROM batches WHERE id=${b};
    SELECT i.external_id AS id, r.first_allowed=1 AND r.blind_allowed=0 AS ok
    FROM restricted_reference_pages r JOIN items i ON i.id=r.item_id AND i.batch_id=r.batch_id WHERE r.batch_id=${b};
    SELECT p.external_id AS id,p.rank,p.content_sha256 AS content,i.external_id AS parent,json_extract(p.media_json,'$.crop.ref.key') AS crop,
      p.active=1 AND p.gate_kind IS NULL AND json_extract(p.payload_json,'$.split')='test' AND json_extract(p.payload_json,'$.trainable')=0
        AND json_extract(p.media_json,'$.crop.ref.source')='r2' AND json_type(p.media_json,'$.page') IS NULL AS ok
    FROM proposals p JOIN items i ON i.id=p.item_id AND i.batch_id=p.batch_id WHERE p.batch_id=${b} ORDER BY p.rank;`);
  if (!batches?.[0]?.ok || items?.length !== bundle.items.length || items.some(row => !row.ok) || lines?.length !== queue.length ||
    !bundle.proposals.every((p, i) => {
      const row = lines[i];
      const ref = prepared.media.get(p.externalId)?.crop?.ref;
      return row?.ok && row.id === p.externalId && row.rank === p.rank && row.parent === p.itemExternalId &&
        row.content === contentSha256(p.contentKey) && ref?.source === "r2" && row.crop === ref.key;
    })) throw new Error("protected D1 readback differs; hold activation");
  console.log(JSON.stringify({ ...counts, production_written: dest === "production", closed: true }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !(error instanceof SyntaxError) && !("code" in error) ? error.message : "protected staging failed");
  process.exitCode = 1;
});
