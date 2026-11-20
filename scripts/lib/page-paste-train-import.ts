import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import sharp from "sharp";
import { PAGE_PASTE_TRAIN } from "../../src/shared/page_paste_train";
import { parseTrainingManifest, restrictedTrainingPath, TRAIN_ID, type TrainingImage, type TrainingPageInput } from "../../src/tasks/page_paste_train/schema";
import { str, type Target } from "./args";
import { checkWriteBudget } from "./d1budget";
import { assertOpenSource } from "./guard";
import { lit } from "./sql";
import { d1File, d1Migrate, d1Query, loadCredentials } from "./wrangler";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PART_SIZE = 32_000; // Base64 characters. Keep each statement well below D1's statement limit.
const FILE_SIZE = 4 * 1024 * 1024; // Bound each separate D1 upload for large manuscripts.
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function openPath(path: string, parent?: string): string {
  if (restrictedTrainingPath(resolve(path))) throw new Error("restricted training input path");
  const real = realpathSync(path);
  if (restrictedTrainingPath(real)) throw new Error("restricted training input path");
  if (parent && !real.startsWith(parent + sep)) throw new Error("input path leaves the training bundle");
  return real;
}

function readInput(path: string, maxBytes: number): Buffer {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error("training bundle input has an invalid size or file type");
  return readFileSync(path);
}

function imageBytes(bundle: string, image: TrainingImage): Buffer {
  const bytes = readInput(openPath(join(bundle, image.path), bundle), MAX_IMAGE_BYTES);
  if (sha(bytes) !== image.sha256) throw new Error(`checksum mismatch: ${image.path}`);
  return bytes;
}

interface StoredBatch {
  task_type: string;
  source_json: string;
  status: string;
  pages: number;
}

function batchState(target: Target, id: string): StoredBatch | undefined {
  return d1Query<StoredBatch>(target, `SELECT task_type, source_json, status,
    (SELECT COUNT(*) FROM page_paste_train_pages WHERE batch_id = b.id) AS pages FROM batches b WHERE id = ${id}`)[0]?.[0];
}

function awaitingBundle(state: StoredBatch, sourceId: string): boolean {
  if (state.task_type !== PAGE_PASTE_TRAIN || state.status !== "closed" || state.pages !== 0) return false;
  const source = JSON.parse(state.source_json);
  return source.split === "train" && source.awaiting_bundle === true && source.catalog?.source_id === sourceId;
}

async function trainingBudget(target: Target, rows: number, flags: Record<string, string | true>) {
  if (target === "production") {
    const credentials = loadCredentials();
    for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DAILY_WRITE_BUDGET"]) {
      if (credentials[key]) process.env[key] = credentials[key];
    }
  }
  await checkWriteBudget(target, rows, flags);
}

async function reserveTrainingBatch(flags: Record<string, string | true>, target: Target) {
  const batchId = str(flags, "batch");
  const sourceId = str(flags, "source-id");
  const title = str(flags, "title");
  if (!TRAIN_ID.test(batchId) || !TRAIN_ID.test(sourceId) || !title.trim() || title.length > 200) {
    throw new Error("invalid training reservation batch id, source id or title");
  }
  const dry = flags["dry-run"] === true;
  if (!dry) {
    if (target === "local") d1Migrate(target);
    const id = lit(batchId);
    const prior = batchState(target, id);
    if (prior && !awaitingBundle(prior, sourceId)) throw new Error("batch id already belongs to another import");
    if (!prior) {
      await trainingBudget(target, 2, flags);
      const source = lit(JSON.stringify({ split: "train", awaiting_bundle: true, catalog: { source_id: sourceId } }));
      d1Query(target, `INSERT INTO batches (id, task_type, title, source_json, status, imported_at)
        VALUES (${id}, ${lit(PAGE_PASTE_TRAIN)}, ${lit(title)}, ${source}, 'closed', ${lit(new Date().toISOString())})
        ON CONFLICT (id) DO NOTHING`);
    }
    const stored = batchState(target, id);
    if (!stored || !awaitingBundle(stored, sourceId)) throw new Error("could not verify the closed empty reservation");
  }
  console.log(JSON.stringify({ batch_id: batchId, source_id: sourceId, pages: 0, status: "closed", awaiting_bundle: true, applied: !dry }));
}

export async function importPagePasteTrain(root: string, flags: Record<string, string | true>, target: Target) {
  if (flags["init-empty"] === true) return reserveTrainingBatch(flags, target);
  const bundle = openPath(str(flags, "bundle"));
  assertOpenSource(bundle);
  const manifestPath = openPath(join(bundle, "manifest.json"), bundle);
  const raw = readInput(manifestPath, 4 * 1024 * 1024);
  const manifestHash = sha(raw);
  if (manifestHash !== str(flags, "manifest-sha256")) throw new Error("training manifest SHA-256 does not match");
  const manifest = parseTrainingManifest(JSON.parse(raw.toString("utf8")));
  const pages: (TrainingPageInput & { position: number; parts: number; encodedBytes: number })[] = [];
  for (const [position, page] of manifest.pages.entries()) {
    const bytes = imageBytes(bundle, page.image);
    const actual = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: "error" }).metadata();
    const ext = extname(page.image.path).slice(1);
    if (actual.format !== (ext === "jpg" ? "jpeg" : ext) || (actual.pages ?? 1) !== 1 ||
      (actual.orientation ?? 1) !== 1 || actual.width !== page.image.width || actual.height !== page.image.height) {
      throw new Error(`image format, frame, orientation or dimensions mismatch: ${page.image.path}`);
    }
    const encodedBytes = Math.ceil(bytes.length / 3) * 4;
    pages.push({ ...page, position, parts: Math.ceil(encodedBytes / PART_SIZE), encodedBytes });
  }

  const summary = {
    batch_id: manifest.batch_id, manifest_sha256: manifestHash, pages: pages.length,
    line_boxes: pages.reduce((n, p) => n + p.line_boxes.length, 0),
    asset_parts: pages.reduce((n, p) => n + p.parts, 0),
    encoded_bytes: pages.reduce((n, p) => n + p.encodedBytes, 0),
  };
  if (flags["dry-run"] === true) {
    console.log(JSON.stringify({ ...summary, applied: false }, null, 2));
    return;
  }
  if (target === "local") d1Migrate(target);

  const id = lit(manifest.batch_id);
  const sameImport = (state: StoredBatch) => {
    const source = JSON.parse(state.source_json);
    return state.task_type === PAGE_PASTE_TRAIN && source.split === "train" && source.manifest_sha256 === manifestHash;
  };
  const prior = batchState(target, id);
  if (prior && !sameImport(prior) && !awaitingBundle(prior, manifest.source.source_id)) throw new Error("batch id already belongs to a different import");

  const loading = `id = ${id} AND task_type = ${lit(PAGE_PASTE_TRAIN)}
    AND json_extract(source_json, '$.manifest_sha256') = ${lit(manifestHash)}
    AND json_extract(source_json, '$.split') = 'train' AND status = 'closed'`;
  if (prior?.status !== "open") {
    // SQLite rows and indexes, plus the initial and final batch updates.
    await trainingBudget(target, 3 * pages.length + 2 * summary.asset_parts + 4, flags);
    const source = lit(JSON.stringify({ split: "train", catalog: manifest.source, manifest_sha256: manifestHash }));
    const now = lit(new Date().toISOString());
    // Update only an empty reservation for this same source. A competing import cannot replace pinned content.
    d1Query(target, `INSERT INTO batches (id, task_type, title, source_json, status, imported_at)
      VALUES (${id}, ${lit(PAGE_PASTE_TRAIN)}, ${lit(manifest.title)}, ${source}, 'closed', ${now})
      ON CONFLICT (id) DO UPDATE SET title = excluded.title, source_json = excluded.source_json, imported_at = excluded.imported_at
      WHERE batches.status = 'closed' AND batches.task_type = excluded.task_type
        AND json_extract(batches.source_json, '$.split') = 'train'
        AND json_extract(batches.source_json, '$.awaiting_bundle') = 1
        AND json_extract(batches.source_json, '$.catalog.source_id') = ${lit(manifest.source.source_id)}
        AND NOT EXISTS (SELECT 1 FROM page_paste_train_pages WHERE batch_id = ${id})`);
    const staged = batchState(target, id);
    if (!staged || !sameImport(staged)) throw new Error("could not stage this manifest");

    const parent = join(root, ".import");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(parent, "page-paste-train-"));
    const file = join(scratch, "import.sql");
    let statements: string[] = [];
    let size = 0;
    function flush() {
      if (!size) return;
      try {
        writeFileSync(file, statements.join("\n"), { mode: 0o600 });
        d1File(target, file);
      } catch (cause) {
        if (target === "local") throw cause;
        throw new Error("D1 rejected a training import file. The same pinned import can resume from its closed batch.", { cause });
      } finally {
        if (statSync(file, { throwIfNoEntry: false })) unlinkSync(file);
      }
      statements = [];
      size = 0;
    }
    function add(statement: string) {
      const bytes = Buffer.byteLength(statement) + 1;
      if (size + bytes > FILE_SIZE) flush();
      statements.push(statement);
      size += bytes;
    }
    try {
      for (const page of pages) {
        const base64 = imageBytes(bundle, page.image).toString("base64");
        add(`INSERT OR IGNORE INTO page_paste_train_pages (batch_id, page_key, position, image_json, line_boxes_json, asset_parts)
          SELECT id, ${lit(page.page_id)}, ${page.position}, ${lit(JSON.stringify(page.image))}, ${lit(JSON.stringify(page.line_boxes))},
            ${page.parts} FROM batches WHERE ${loading};`);
        for (let part = 0; part < page.parts; part++) {
          const chunk = base64.slice(part * PART_SIZE, (part + 1) * PART_SIZE);
          add(`INSERT OR IGNORE INTO page_paste_train_assets (page_id, part, base64)
            SELECT p.id, ${part}, ${lit(chunk)} FROM page_paste_train_pages p
            WHERE p.batch_id = (SELECT id FROM batches WHERE ${loading}) AND p.position = ${page.position};`);
        }
      }
      flush();
    } finally {
      rmdirSync(scratch);
    }
  }

  // Verify each page, box list and complete ordered image assembly before opening.
  const stored = d1Query<{
    page_key: string; position: number; image_json: string; line_boxes_json: string; parts: number; last_part: number; encoded_bytes: number;
  }>(target, `SELECT p.page_key, p.position, p.image_json, p.line_boxes_json, COUNT(a.part) AS parts,
    MAX(a.part) AS last_part, SUM(LENGTH(a.base64)) AS encoded_bytes
    FROM page_paste_train_pages p LEFT JOIN page_paste_train_assets a ON a.page_id = p.id
    WHERE p.batch_id = ${id} GROUP BY p.id ORDER BY p.position`)[0] ?? [];
  if (stored.length !== pages.length || stored.some((r, i) => {
    const page = pages[i]!;
    return r.page_key !== page.page_id || r.position !== i || r.image_json !== JSON.stringify(page.image) ||
      r.line_boxes_json !== JSON.stringify(page.line_boxes) || r.parts !== page.parts ||
      r.last_part !== page.parts - 1 || r.encoded_bytes !== page.encodedBytes;
  })) throw new Error("training bundle did not pass readback");
  if (prior?.status !== "open") d1Query(target, `UPDATE batches SET status = 'open' WHERE ${loading}`);
  const final = batchState(target, id);
  if (!final || !sameImport(final) || final.status !== "open") throw new Error("training batch is not open at this manifest hash");
  console.log(JSON.stringify({ ...summary, status: "open", applied: true }, null, 2));
}
