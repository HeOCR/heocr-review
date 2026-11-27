import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { lineTextProblems } from "../../src/tasks/line_verify/schema";
import { PROOFREAD_KIND, PROOFREAD_PREFIX, PROOFREAD_SCHEMA, type ProofreadRegion } from "../../src/tasks/reference_proofread";
import type { ImportBundle } from "../../src/tasks/import";
import type { ProposalMedia } from "../../src/tasks/types";
import { buildImportStatements } from "./importsql";
import { lit } from "./sql";

const sha = /^[a-f0-9]{64}$/;
const leafId = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const proofreadDigest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

interface SourceLine {
  leaf: string;
  region: number;
  ordinal: number;
  position: number;
  hard: boolean;
  before: string;
  crop_sha256: string;
  width: number;
  height: number;
  box: [number, number, number, number];
}
interface SourceRegion {
  leaf: string;
  region: number;
  sha256: string;
  width: number;
  height: number;
}

export function proofreadBundle(raw: Buffer, manifestSha: string, id: string, title: string) {
  if (!id.startsWith(PROOFREAD_PREFIX) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id) || lineTextProblems(title).length) {
    throw new Error("expected a restricted proofread batch id and title");
  }
  if (!sha.test(manifestSha) || proofreadDigest(raw) !== manifestSha) throw new Error("proofread manifest pin mismatch");
  const doc = JSON.parse(raw.toString("utf8")) as { schema: string; reference_sha256: string; rows: SourceLine[]; regions: SourceRegion[] };
  if (doc.schema !== PROOFREAD_SCHEMA || !sha.test(doc.reference_sha256) || !Array.isArray(doc.rows) || !doc.rows.length || !Array.isArray(doc.regions)) {
    throw new Error("invalid proofread manifest");
  }
  const items = new Map<string, ImportBundle["items"][number]>();
  const regions = new Map<string, { source: SourceRegion; region: ProofreadRegion }>();
  for (const source of doc.regions) {
    if (!source || typeof source.leaf !== "string" || !leafId.test(source.leaf) || !sha.test(source.sha256) ||
      ![source.region, source.width, source.height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error("invalid region pin");
    const id = `${source.leaf}-r${source.region}`;
    if (regions.has(id)) throw new Error("duplicate proofread region");
    regions.set(id, { source, region: { leaf: source.leaf, region: source.region, sha256: source.sha256,
      image: { ref: { source: "r2", key: source.sha256 + ".png" }, width: source.width, height: source.height, box: null },
      bands: [] } });
  }
  const leaves = new Map<string, { ordinal: number; region: number }>();
  for (const [i, row] of doc.rows.entries()) {
    if (!row || typeof row.leaf !== "string" || !leafId.test(row.leaf) || typeof row.hard !== "boolean" ||
      !sha.test(row.crop_sha256) || ![row.region, row.ordinal, row.width, row.height].every(v => Number.isSafeInteger(v) && v > 0) ||
      row.position !== i + 1 || lineTextProblems(row.before).length || row.before !== row.before.trim()) {
      throw new Error("invalid proofread position, crop pin, or sealed text");
    }
    const previous = leaves.get(row.leaf);
    if ((previous?.ordinal ?? 0) + 1 !== row.ordinal ||
        (previous?.region ?? 1) > row.region || row.region > (previous?.region ?? 0) + 1) {
      throw new Error("proofread leaf order or ordinal is not contiguous");
    }
    leaves.set(row.leaf, { ordinal: row.ordinal, region: row.region });
    const region = `${row.leaf}-r${row.region}`;
    const pinned = regions.get(region);
    if (!pinned || !Array.isArray(row.box) || row.box.length !== 4 || !row.box.every(Number.isSafeInteger)) throw new Error("missing region or line box");
    const [x0, y0, x1, y1] = row.box;
    const { width, height } = pinned.source;
    const prev = pinned.region.bands.at(-1);
    if (x0 !== 0 || x1 !== width || y0 / height !== (prev?.box[3] ?? 0) || y1 > height ||
        row.width !== width || row.height !== y1 - y0) throw new Error("crop dimensions or reading bands differ from the pinned region");
    pinned.region.bands.push({ ordinal: row.ordinal, box: [0, y0 / height, 1, y1 / height] });
    if (!items.has(region)) items.set(region, { externalId: region, title: region,
      payload: { split: "test", trainable: false, proofread_region: pinned.region }, imageStem: null });
  }
  if (items.size !== regions.size || [...regions.values()].some(r => r.region.bands.at(-1)?.box[3] !== 1)) {
    throw new Error("regions and line bands must cover the same scope");
  }
  if (proofreadDigest(doc.rows.map(row => row.before + "\n").join("")) !== doc.reference_sha256) {
    throw new Error("prefill differs from the sealed reference");
  }
  const queue = [...doc.rows].sort((a, b) => Number(b.hard) - Number(a.hard) || a.position - b.position);
  const bundle: ImportBundle = {
    batch: { id, title, taskType: "line_verify", source: {
      restricted_review: PROOFREAD_KIND, proofread_schema: PROOFREAD_SCHEMA, split: "test", trainable: false, manifest_sha256: manifestSha, reference_sha256: doc.reference_sha256,
    } },
    items: [...items.values()],
    proposals: queue.map((row, rank) => ({
      externalId: `${row.leaf}-${row.ordinal}`,
      itemExternalId: `${row.leaf}-r${row.region}`,
      category: "proofread", confidence: "", rank, pageBox: null,
      contentKey: { manifestSha, position: row.position, cropSha: row.crop_sha256, before: row.before },
      payload: {
        candidate_text: row.before, candidate_provenance: "sealed_reference", attention_spans: [],
        line_index: row.ordinal, pass: 1, order: row.position, leaf: row.leaf, region: row.region,
        crop_sha256: row.crop_sha256, split: "test", trainable: false,
        page: { source: "held_out_reference", book_title: row.leaf, page_label: `${row.leaf}/${row.region}`,
          attribution: "", text_license: "", release_split: "test" },
      },
    })),
  };
  return { bundle, queue, regions: doc.regions, leaves: leaves.size, hard: queue.filter(row => row.hard).length };
}

export async function proofreadMedia(stage: ReturnType<typeof proofreadBundle>, root: string, put?: (key: string, bytes: Buffer) => void) {
  const media = new Map<string, ProposalMedia>();
  const objects = new Map<string, { size: number; etag: string }>();
  async function verifyPng(sha256: string, width: number, height: number) {
    const key = sha256 + ".png";
    const namespaced = stage.bundle.batch.id + "/" + key;
    const path = join(root, key);
    if (!lstatSync(path).isFile()) throw new Error("expected a regular pinned PNG");
    const bytes = readFileSync(path);
    if (proofreadDigest(bytes) !== sha256) throw new Error("proofread media pin mismatch");
    const meta = await sharp(bytes, { failOn: "error" }).metadata();
    if (meta.format !== "png" || meta.width !== width || meta.height !== height) throw new Error("proofread PNG dimensions or format differ");
    if (!objects.has(namespaced)) {
      put?.(namespaced, bytes);
      objects.set(namespaced, { size: bytes.length, etag: createHash("md5").update(bytes).digest("hex") });
    }
    return key;
  }
  for (const region of stage.regions) await verifyPng(region.sha256, region.width, region.height);
  for (const [i, row] of stage.queue.entries()) {
    const key = await verifyPng(row.crop_sha256, row.width, row.height);
    media.set(stage.bundle.proposals[i]!.externalId, {
      crop: { ref: { source: "r2", key }, width: row.width, height: row.height, box: [0, 0, 1, 1] },
    });
  }
  return { media, objects };
}

export function proofreadStageSql(bundle: ImportBundle, media: Map<string, ProposalMedia>, now: string) {
  const b = lit(bundle.batch.id);
  return [
    `INSERT INTO batches (id,task_type,title,source_json,min_reviewers,status,imported_at,restricted_reference)
     VALUES (${b},'line_verify',${lit(bundle.batch.title)},${lit(JSON.stringify(bundle.batch.source))},1,'closed',${lit(now)},1);`,
    ...buildImportStatements(bundle, media, { minReviewers: 1, importedAt: now }).slice(1),
    `INSERT INTO restricted_reference_pages (batch_id,item_id,first_allowed,blind_allowed)
     SELECT batch_id,id,1,0 FROM items WHERE batch_id=${b};`,
  ].join("\n") + "\n";
}
