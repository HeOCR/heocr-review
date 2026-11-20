import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import { SYNTH_REALISM } from "../../src/shared/synth_realism";
import { IMAGE_FIELDS, MANIFEST_SCHEMA, isSha, parseManifest, restrictedPath, verifyClearance, type ImageFile } from "../../src/tasks/synth_realism/schema";
import { str, type Target } from "./args";
import { assertOpenSource } from "./guard";
import { lit } from "./sql";
import { checkWriteBudget } from "./d1budget";
import { d1File, d1Migrate, d1Query, loadCredentials } from "./wrangler";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function openPath(path: string): string {
  if (restrictedPath(resolve(path))) throw new Error("restricted realism input path");
  const real = realpathSync(path);
  if (restrictedPath(real)) throw new Error("restricted realism input path");
  return real;
}

function readJson(path: string) {
  const file = openPath(path);
  assertOpenSource(file);
  if (statSync(file).size > 1024 * 1024) throw new Error("realism JSON input is larger than 1 MiB");
  const bytes = readFileSync(file);
  return { bytes, hash: sha256(bytes) };
}

async function jpeg(bundle: string, image: ImageFile, line: boolean): Promise<Buffer> {
  const file = openPath(join(bundle, image.path));
  if (!file.startsWith(bundle + sep)) throw new Error("image path leaves the bundle");
  if (statSync(file).size > 20 * 1024 * 1024) throw new Error("realism image is larger than 20 MiB");
  const bytes = readFileSync(file);
  if (sha256(bytes) !== image.sha256) throw new Error("realism image checksum mismatch");
  const raster = sharp(bytes, { failOn: "error", limitInputPixels: 25_000_000 });
  const metadata = await raster.metadata();
  if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1) {
    throw new Error("realism assets must be single-frame JPEG, PNG or WebP");
  }
  // Same pipeline for both sides. Re-encoding also strips original names, EXIF, and other metadata.
  return raster.rotate().flatten({ background: "#ffffff" })
    .resize({ width: line ? 1200 : 1440, height: line ? 384 : 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

interface BatchState {
  task_type: string;
  status: string;
  source_json: string;
  items: number;
}

function stateOf(target: Target, batch: string): BatchState | undefined {
  return d1Query<BatchState>(target, `SELECT task_type, status, source_json,
    (SELECT COUNT(*) FROM synth_realism_items WHERE batch_id = b.id) AS items FROM batches b WHERE id = ${batch}`)[0]?.[0];
}

function awaitingBundle(state: BatchState): boolean {
  return state.task_type === SYNTH_REALISM && state.status === "closed" && state.items === 0 &&
    JSON.parse(state.source_json).awaiting_bundle === true;
}

async function budget(target: Target, writes: number) {
  if (target === "production") {
    const credentials = loadCredentials();
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DAILY_WRITE_BUDGET"]) {
      if (credentials[key]) process.env[key] = credentials[key];
    }
  }
  await checkWriteBudget(target, writes, {});
}

async function reserveBatch(target: Target, batchId: string, dry: boolean) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(batchId)) throw new Error("invalid reserved batch id");
  const batch = lit(batchId);
  if (!dry) {
    if (target === "local") d1Migrate(target);
    const before = stateOf(target, batch);
    if (before && !awaitingBundle(before)) throw new Error("batch id already exists and is not an empty reservation");
    if (!before) {
      await budget(target, 3);
      d1Query(target, `INSERT INTO batches (id, task_type, title, source_json, status, imported_at)
        VALUES (${batch}, ${lit(SYNTH_REALISM)}, ${batch}, '{"awaiting_bundle":true}', 'closed', ${lit(new Date().toISOString())})
        ON CONFLICT (id) DO NOTHING`);
    }
    const after = stateOf(target, batch);
    if (!after || !awaitingBundle(after)) throw new Error("could not verify the closed empty reservation");
  }
  console.log(JSON.stringify({ batch: batchId, items: 0, status: "closed", awaiting_bundle: true, applied: !dry }));
}

export async function importSynthRealism(root: string, flags: Record<string, string | true>, target: Target): Promise<void> {
  const dry = flags["dry-run"] === true;
  const fixture = flags.fixture === true;
  if (target === "production" && fixture) throw new Error("fixture imports are local only");
  if (flags["init-empty"] === true) return reserveBatch(target, str(flags, "batch", SYNTH_REALISM), dry);
  const bundle = openPath(str(flags, "bundle"));
  assertOpenSource(bundle);
  const rawManifest = readJson(join(bundle, "manifest.json"));
  const rawClearance = readJson(str(flags, "clearance"));
  const expected = str(flags, "clearance-sha256");
  if (!isSha(expected) || rawClearance.hash !== expected) throw new Error("eval clearance SHA-256 does not match the pinned hash");
  const manifestJson = JSON.parse(rawManifest.bytes.toString("utf8"));
  const clearanceJson = JSON.parse(rawClearance.bytes.toString("utf8"));
  const manifest = parseManifest(manifestJson);
  if ((manifestJson.fixture === true) !== fixture || (clearanceJson.fixture === true) !== fixture) {
    throw new Error("both JSON inputs and --fixture must agree on fixture status");
  }
  verifyClearance(clearanceJson, manifest);
  const destination = flags["into-empty-batch"];
  if (destination !== undefined && (typeof destination !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(destination))) {
    throw new Error("--into-empty-batch requires an empty reservation id");
  }
  const batchId = destination ?? manifest.batch_id;
  const batch = lit(batchId);
  let reserved = false;
  if (!dry) {
    if (target === "local") d1Migrate(target);
    const existing = stateOf(target, batch);
    if (existing && !awaitingBundle(existing)) throw new Error("batch already contains a session; use a new id");
    if (destination && !existing) throw new Error("the requested empty batch has not been reserved");
    reserved = existing !== undefined;
  }
  const manifestHash = lit(rawManifest.hash);
  const loading = `id = ${batch} AND status = 'closed' AND task_type = ${lit(SYNTH_REALISM)}
    AND json_extract(source_json, '$.manifest_sha256') = ${manifestHash}`;

  const assets = new Map<string, string>();
  const normalized = new Map<string, string>();
  const items: string[] = [];
  for (const item of manifest.items) {
    const hashes: string[] = [];
    for (const field of IMAGE_FIELDS) {
      const file = item[field];
      const line = field.endsWith("_crop");
      const key = JSON.stringify([file.path, file.sha256, line]);
      let hash = normalized.get(key);
      if (!hash) {
        const bytes = await jpeg(bundle, file, line);
        hash = sha256(bytes);
        normalized.set(key, hash);
        assets.set(hash, bytes.toString("base64"));
      }
      hashes.push(hash);
    }
    if (hashes[0] === hashes[2] || hashes[1] === hashes[3]) throw new Error("a pair is identical after image normalization");
    items.push(`INSERT INTO synth_realism_items
      (batch_id, external_id, synthetic_image, synthetic_line_crop, real_ref_image, real_ref_line_crop,
       generator_id, generator_version, params_hash, control_kind)
      VALUES ((SELECT id FROM batches WHERE ${loading}), ${[item.item_id, ...hashes, item.generator_id, item.generator_version, item.params_hash, item.control_kind].map(lit).join(", ")});`);
  }
  const counts = {
    batch: batchId, manifest_batch_id: manifest.batch_id, items: items.length, assets: assets.size, fixture,
    real_real: manifest.items.filter((item) => item.control_kind === "real_real").length,
    attention: manifest.items.filter((item) => item.control_kind === "attention").length,
    manifest_sha256: rawManifest.hash, clearance_sha256: rawClearance.hash,
    applied: !dry,
  };
  if (counts.applied) {
    const source = { schema: MANIFEST_SCHEMA, manifest_batch_id: manifest.batch_id,
      manifest_sha256: rawManifest.hash, clearance_sha256: rawClearance.hash, fixture };
    const statements = [];
    // Keep each literal below D1's statement limit. These objects are private and never placed under public/media.
    for (const [hash, base64] of assets) {
      const parts = base64.match(/.{1,32000}/g)!;
      for (const [part, data] of parts.entries()) {
        statements.push(`INSERT OR IGNORE INTO synth_realism_assets (sha256,part,base64) VALUES (${lit(hash)},${part},${lit(data)});`);
      }
    }
    await budget(target, statements.length * 2 + items.length * 3 + 4);
    const sourceJson = lit(JSON.stringify(source));
    const now = lit(new Date().toISOString());
    const stage = reserved
      ? `UPDATE batches SET source_json = ${sourceJson}, imported_at = ${now}
        WHERE id = ${batch} AND task_type = ${lit(SYNTH_REALISM)} AND status = 'closed'
        AND json_extract(source_json, '$.awaiting_bundle') = 1
        AND NOT EXISTS (SELECT 1 FROM synth_realism_items WHERE batch_id = ${batch});`
      : `INSERT INTO batches (id, task_type, title, source_json, status, imported_at)
        VALUES (${batch}, ${lit(SYNTH_REALISM)}, ${batch}, ${sourceJson}, 'closed', ${now});`;
    statements.push(stage, ...items,
      `UPDATE batches SET status = 'open' WHERE ${loading}
        AND (SELECT COUNT(*) FROM synth_realism_items WHERE batch_id = ${batch}) = ${items.length};`);
    const parent = join(root, ".import");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const folder = mkdtempSync(join(parent, "realism-"));
    chmodSync(folder, 0o700);
    const sql = join(folder, "import.sql");
    try {
      writeFileSync(sql, statements.join("\n"), { mode: 0o600 });
      try {
        d1File(target, sql);
      } catch (cause) {
        if (target === "local") throw cause;
        throw new Error("D1 rejected the import file; check the batch state before retrying", { cause });
      }
    } finally {
      if (statSync(sql, { throwIfNoEntry: false })) unlinkSync(sql);
      rmdirSync(folder);
    }
    const stored = stateOf(target, batch);
    if (!stored || stored.status !== "open" || stored.items !== items.length ||
      JSON.parse(stored.source_json).manifest_sha256 !== rawManifest.hash) {
      throw new Error("the loaded batch did not pass readback");
    }
  }
  console.log(JSON.stringify(counts, null, 2));
}
