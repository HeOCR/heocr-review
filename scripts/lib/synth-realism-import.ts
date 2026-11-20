import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import { SYNTH_REALISM } from "../../src/shared/synth_realism";
import { IMAGE_FIELDS, MANIFEST_SCHEMA, isSha, parseManifest, restrictedPath, verifyClearance, type ImageFile } from "../../src/tasks/synth_realism/schema";
import { str, type Target } from "./args";
import { assertOpenSource } from "./guard";
import { lit } from "./sql";
import { d1File, d1Migrate, d1Query } from "./wrangler";

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

export async function importSynthRealism(root: string, flags: Record<string, string | true>, target: Target): Promise<void> {
  if (target !== "local") throw new Error("synth_realism imports are local only");
  const bundle = openPath(str(flags, "bundle"));
  assertOpenSource(bundle);
  const rawManifest = readJson(join(bundle, "manifest.json"));
  const rawClearance = readJson(str(flags, "clearance"));
  const expected = str(flags, "clearance-sha256");
  if (!isSha(expected) || rawClearance.hash !== expected) throw new Error("eval clearance SHA-256 does not match the pinned hash");
  const manifestJson = JSON.parse(rawManifest.bytes.toString("utf8"));
  const clearanceJson = JSON.parse(rawClearance.bytes.toString("utf8"));
  const manifest = parseManifest(manifestJson);
  const fixture = flags.fixture === true;
  if ((manifestJson.fixture === true) !== fixture || (clearanceJson.fixture === true) !== fixture) {
    throw new Error("both JSON inputs and --fixture must agree on fixture status");
  }
  verifyClearance(clearanceJson, manifest);
  const batch = lit(manifest.batch_id);
  if (flags["dry-run"] !== true) {
    d1Migrate("local");
    if (d1Query("local", `SELECT 1 FROM batches WHERE id = ${batch}`)[0]?.length) throw new Error("batch already exists; use a new session id");
  }

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
      VALUES (${batch}, ${[item.item_id, ...hashes, item.generator_id, item.generator_version, item.params_hash, item.control_kind].map(lit).join(", ")});`);
  }
  const counts = {
    batch: manifest.batch_id, items: items.length, assets: assets.size, fixture,
    real_real: manifest.items.filter((item) => item.control_kind === "real_real").length,
    attention: manifest.items.filter((item) => item.control_kind === "attention").length,
    manifest_sha256: rawManifest.hash, clearance_sha256: rawClearance.hash,
    applied: flags["dry-run"] !== true,
  };
  if (counts.applied) {
    const source = { schema: MANIFEST_SCHEMA, manifest_sha256: rawManifest.hash, clearance_sha256: rawClearance.hash, fixture };
    const statements = [];
    // Keep each literal below D1's statement limit. These objects are private and never placed under public/media.
    for (const [hash, base64] of assets) {
      const parts = base64.match(/.{1,32000}/g)!;
      for (const [part, data] of parts.entries()) {
        statements.push(`INSERT OR IGNORE INTO synth_realism_assets (sha256,part,base64) VALUES (${lit(hash)},${part},${lit(data)});`);
      }
    }
    statements.push(`INSERT INTO batches (id, task_type, title, source_json, status, imported_at)
      VALUES (${batch}, ${lit(SYNTH_REALISM)}, ${batch}, ${lit(JSON.stringify(source))}, 'open', ${lit(new Date().toISOString())});`, ...items);
    const parent = join(root, ".import");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const folder = mkdtempSync(join(parent, "realism-"));
    chmodSync(folder, 0o700);
    const sql = join(folder, "import.sql");
    try {
      writeFileSync(sql, statements.join("\n"), { mode: 0o600 });
      d1File("local", sql);
    } finally {
      if (statSync(sql, { throwIfNoEntry: false })) unlinkSync(sql);
      rmdirSync(folder);
    }
  }
  console.log(JSON.stringify(counts, null, 2));
}
