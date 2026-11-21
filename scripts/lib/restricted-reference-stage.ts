import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { Box } from "../../src/shared/media";
import type { ImportProposal } from "../../src/tasks/import";
import type { ProposalMedia, StoredImage } from "../../src/tasks/types";
import { buildImportStatements } from "./importsql";
import { LINE_CROP_MAX_WIDTH, lineCropRect } from "./media";
import { digest, type RestrictedImport } from "./restricted-reference-import";
import { lit } from "./sql";

export interface ObjectReadback {
  key: string;
  size: number;
  etag: string;
}

export function disabledR2FixtureUrl(managed: { enabled?: boolean; domain?: string } | null, key: string): URL {
  if (managed?.enabled !== false || typeof managed.domain !== "string" || !/^[a-z0-9-]+\.r2\.dev$/i.test(managed.domain)) {
    throw new Error("expected a disabled managed R2 hostname");
  }
  return new URL("https://" + managed.domain + "/" + encodeURIComponent(key));
}

export async function assertAnonymousR2Denial(managed: URL, s3: URL): Promise<{ managed: number; s3: number }> {
  async function probe(endpoint: string, url: URL): Promise<number> {
    const response = await fetch(url, {
      credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (response.ok) {
      throw new Error(`anonymous ${endpoint} R2 access ${response.redirected ? "redirected to content" : "succeeded"} (HTTP ${response.status})`);
    }
    return response.status;
  }

  const [managedStatus, s3Status] = await Promise.all([probe("managed", managed), probe("S3", s3)]);
  return { managed: managedStatus, s3: s3Status };
}

/** Use only the named private object namespace. Images never enter the static tree. */
export async function prepareRestrictedMedia(
  stage: RestrictedImport,
  put?: (key: string, bytes: Buffer) => void,
) {
  const { bundle, paths } = stage;
  const itemImages = new Map<string, StoredImage>();
  const media = new Map<string, ProposalMedia>();
  const objects = new Map<string, ObjectReadback>();
  function store(bytes: Buffer, ext: string, width: number, height: number, box: Box | null): StoredImage {
    const key = `${digest(bytes)}.${ext}`;
    const namespaced = `${bundle.batch.id}/${key}`;
    if (!objects.has(namespaced)) {
      put?.(namespaced, bytes);
      objects.set(namespaced, { key: namespaced, size: bytes.length, etag: digest(bytes, "md5") });
    }
    return { ref: { source: "r2", key }, width, height, box };
  }

  const byPage = new Map<string, ImportProposal[]>();
  for (const line of bundle.proposals) {
    const lines = byPage.get(line.itemExternalId) ?? [];
    lines.push(line);
    byPage.set(line.itemExternalId, lines);
  }
  for (const item of bundle.items) {
    const src = item.bundleImage!;
    const bytes = readFileSync(paths.get(item.externalId)!);
    if (digest(bytes) !== src.sha256) throw new Error("page pin changed during staging");
    const suffix = src.path.split(".").at(-1)!.toLowerCase();
    const page = store(bytes, suffix === "jpeg" ? "jpg" : suffix, src.width!, src.height!, null);
    itemImages.set(item.externalId, page);
    // Decode the pinned page once. Use the established context-aware line crop for each item.
    const { data, info } = await sharp(bytes, { failOn: "error" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    for (const proposal of byPage.get(item.externalId)!) {
      const box = proposal.pageBox!;
      const crop = lineCropRect(box, proposal.contextBox!, width, height);
      const { data: jpeg, info: out } = await sharp(data, { raw: { width, height, channels } })
        .extract(crop).resize({ width: Math.min(crop.width, LINE_CROP_MAX_WIDTH) })
        .jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      const rel = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
      const cropBox: Box = [
        rel((box[0] * width - crop.left) / crop.width), rel((box[1] * height - crop.top) / crop.height),
        rel((box[2] * width - crop.left) / crop.width), rel((box[3] * height - crop.top) / crop.height),
      ];
      media.set(proposal.externalId, {
        page: { ...page, box },
        crop: store(jpeg, "jpg", out.width, out.height, cropBox),
      });
    }
  }
  return { itemImages, media, objects };
}

type RestrictedMedia = Awaited<ReturnType<typeof prepareRestrictedMedia>>;

/** Compare single-part R2 ETags and byte lengths to the locally SHA-addressed objects. */
export function buildRestrictedStageSql(stage: RestrictedImport, prepared: RestrictedMedia, readback: Iterable<ObjectReadback>, now: string): string {
  const { bundle, pins } = stage;
  const live = new Map<string, ObjectReadback>();
  for (const row of readback) {
    if (live.has(row.key)) throw new Error("duplicate object in the private bucket readback");
    live.set(row.key, row);
  }
  for (const [key, expected] of prepared.objects) {
    const object = live.get(key);
    if (!object || object.size !== expected.size || object.etag !== expected.etag) {
      throw new Error("private bucket readback did not verify every staged object");
    }
  }
  function verified(image: StoredImage | undefined): boolean {
    return image?.ref.source === "r2" && prepared.objects.has(`${bundle.batch.id}/${image.ref.key}`);
  }
  if (bundle.items.some((item) => !verified(prepared.itemImages.get(item.externalId))) ||
    bundle.proposals.some((p) => !verified(prepared.media.get(p.externalId)?.page) || !verified(prepared.media.get(p.externalId)?.crop))) {
    throw new Error("stage contains a media reference without a verified private object");
  }

  const b = lit(bundle.batch.id);
  const importedAt = lit(now);
  // The explicit INSERT is first in the D1 transaction. A retry cannot overwrite an existing batch.
  const statements = [`INSERT INTO batches (id, task_type, title, source_json, min_reviewers, status, imported_at, restricted_reference)
    VALUES (${b}, 'line_verify', ${lit(bundle.batch.title)}, ${lit(JSON.stringify(bundle.batch.source))}, 1, 'closed', ${importedAt}, 1);`];
  statements.push(...buildImportStatements(bundle, prepared.media, {
    minReviewers: 1, importedAt: now, itemImages: prepared.itemImages,
    planted: new Set(stage.plants.rows.map(row => row.item_id)),
  }).slice(1));
  statements.push(`INSERT INTO restricted_reference_pages (batch_id, item_id, first_allowed, blind_allowed)
    SELECT batch_id, id, 1, 0 FROM items WHERE batch_id=${b};`);
  statements.push(`INSERT INTO batch_settings (batch_id, updated_at, updated_by, mode, pointed_books)
    VALUES (${b}, ${importedAt}, 'restricted-import', ${lit(pins.plantsSha === null ? "standard" : "triage")}, 'keep');`);
  for (const row of stage.plants.rows) {
    const item = lit(row.item_id);
    statements.push(`INSERT INTO triage_plants (batch_id, proposal_id, item_id, plant_type, position, planted_text, planted_sha256, candidate_sha256, plants_sha256, imported_at)
      SELECT ${b}, p.id, ${item}, ${lit(row.plant_type)}, ${lit(row.position)}, ${lit(row.planted_text)}, ${lit(row.planted_sha256)},
        ${lit(row.candidate_sha256)}, ${lit(pins.plantsSha)}, ${importedAt}
      FROM proposals p WHERE p.batch_id=${b} AND p.external_id=${item} AND p.active=1;`);
  }
  return statements.join("\n") + "\n";
}
