import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RANKING_LABEL, SYNTH_REALISM } from "../src/shared/synth_realism";
import { parseRankingManifest, RANKING_SCHEMA } from "../src/tasks/synth_realism/ranking";
import { isSha } from "../src/tasks/synth_realism/schema";
import { parseArgs, str, target } from "./lib/args";
import { assertOpenSource } from "./lib/guard";
import { lit } from "./lib/sql";
import { budget, jpeg, openPath, readJson } from "./lib/synth-realism-import";
import { d1File, d1Migrate, d1Query } from "./lib/wrangler";

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const deployment = target(flags);
  const fixture = flags.fixture === true;
  const dry = flags["dry-run"] === true;
  if (deployment === "production" && fixture) throw new Error("fixture imports are local only");
  const bundle = openPath(str(flags, "bundle"));
  assertOpenSource(bundle);
  const rawManifest = readJson(join(bundle, "manifest.json"));
  const rawClearance = readJson(str(flags, "clearance"));
  const manifestPin = str(flags, "manifest-sha256");
  const clearancePin = str(flags, "clearance-sha256");
  if (!isSha(manifestPin) || !isSha(clearancePin) || rawManifest.hash !== manifestPin || rawClearance.hash !== clearancePin) {
    throw new Error("ranking inputs do not match the pinned SHA-256 values");
  }
  const manifestJson = JSON.parse(rawManifest.bytes.toString("utf8"));
  const clearance = JSON.parse(rawClearance.bytes.toString("utf8"));
  const manifest = parseRankingManifest(manifestJson, clearance);
  if ((manifestJson.fixture === true) !== fixture || (clearance.fixture === true) !== fixture) {
    throw new Error("ranking inputs and fixture flag disagree");
  }
  const batch = lit(manifest.batch_id);
  const assets = new Map<string, string>();
  const images = new Map<string, { arm: string | null; hash: string }>();
  for (const image of manifest.images) {
    const bytes = await jpeg(bundle, image, false);
    const hash = digest(bytes);
    if (assets.has(hash)) throw new Error("ranking images collapse to identical bytes after normalization");
    assets.set(hash, bytes.toString("base64"));
    images.set(image.item_id, { arm: image.arm_id, hash });
  }
  // Keep controls interleaved even when the source manifest groups them together.
  const order = manifest.pairs.map(pair => ({ pair, key: digest(manifestPin + ":" + pair.pair_id) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const controls = { standard: 0, real_synth: 0, real_real: 0 };
  const pairs = order.map(({ pair }, i) => {
    const a = images.get(pair.item_a)!, b = images.get(pair.item_b)!;
    if (a.arm !== null && b.arm !== null) controls.standard++;
    else if (a.arm === b.arm) controls.real_real++;
    else controls.real_synth++;
    return `INSERT INTO synth_ranking_pairs (batch_id,position,pair_id,item_a,arm_a,image_a,item_b,arm_b,image_b)
      VALUES (${[manifest.batch_id, i + 1, pair.pair_id, pair.item_a, a.arm, a.hash, pair.item_b, b.arm, b.hash].map(lit).join(",")});`;
  });
  const statements: string[] = [];
  for (const [hash, base64] of assets) {
    for (const [part, data] of base64.match(/.{1,32000}/g)!.entries()) {
      statements.push(`INSERT OR IGNORE INTO synth_realism_assets (sha256, part, base64) VALUES (${lit(hash)},${part},${lit(data)});`);
    }
  }
  const estimatedWrites = 4 + 2 * (statements.length + pairs.length) + 2 * pairs.length;
  if (!dry) {
    if (deployment === "local") d1Migrate(deployment);
    if (d1Query(deployment, `SELECT 1 FROM batches WHERE id=${batch}`)[0]?.length) {
      throw new Error("ranking batch already exists; use a new id");
    }
    await budget(deployment, estimatedWrites);
    const source = lit(JSON.stringify({ schema: RANKING_SCHEMA, realism_mode: "ranking", manifest_sha256: manifestPin,
      clearance_sha256: clearancePin, fixture }));
    const stage = `INSERT INTO batches (id, task_type, title, source_json, status, imported_at)
      VALUES (${batch}, ${lit(SYNTH_REALISM)}, ${lit(RANKING_LABEL.he)}, ${source}, 'closed', ${lit(new Date().toISOString())});`;
    const folder = mkdtempSync(join(tmpdir(), "realism-ranking-"));
    chmodSync(folder, 0o700);
    try {
      const file = join(folder, "import.sql");
      writeFileSync(file, [stage, ...statements, ...pairs].join("\n"), { mode: 0o600 });
      d1File(deployment, file);
    } finally {
      rmSync(folder, { recursive: true });
    }
    const stored = d1Query<{ status: string; pin: string; pairs: number; missing: number }>(deployment,
      `SELECT status, json_extract(source_json,'$.manifest_sha256') AS pin,
        (SELECT COUNT(*) FROM synth_ranking_pairs WHERE batch_id=${batch}) AS pairs,
        (SELECT COUNT(*) FROM synth_ranking_pairs p WHERE p.batch_id=${batch} AND
          (NOT EXISTS (SELECT 1 FROM synth_realism_assets WHERE sha256=p.image_a AND part=0)
           OR NOT EXISTS (SELECT 1 FROM synth_realism_assets WHERE sha256=p.image_b AND part=0))) AS missing
          FROM batches WHERE id=${batch}`)[0]?.[0];
    if (!stored || stored.status !== "closed" || stored.pin !== manifestPin || stored.pairs !== pairs.length || stored.missing) {
      throw new Error("closed ranking batch failed readback");
    }
  }
  console.log(JSON.stringify({ batch: manifest.batch_id, manifest_sha256: manifestPin, clearance_sha256: clearancePin,
    pairs: pairs.length, controls, assets: assets.size, status: dry ? "dry-run" : "closed", estimatedWrites }, null, 2));
}

await main();
