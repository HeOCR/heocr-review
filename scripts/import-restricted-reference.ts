import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs, str, target } from "./lib/args";
import { checkWriteBudget, estimateImportWrites } from "./lib/d1budget";
import { importProposalContent } from "./lib/importsql";
import { prepareRestrictedReferenceImport, type RestrictedImport, type RestrictedPins } from "./lib/restricted-reference-import";
import { assertAnonymousR2Denial, buildRestrictedStageSql, disabledR2FixtureUrl, prepareRestrictedMedia, type ObjectReadback } from "./lib/restricted-reference-stage";
import { lit } from "./lib/sql";
import { d1File, d1Query, loadCredentials } from "./lib/wrangler";
import type { StoredImage } from "../src/tasks/types";
import { DRAFT_VERIFICATION } from "../src/tasks/restricted_reference";

const bucket = "heocr-review-protected";
const accessFixture = { key: "access-check.txt", text: "HeOCR private object access fixture\n" };

interface CloudflareResponse<T> {
  success: boolean;
  result: T;
  result_info?: { cursor?: string; is_truncated?: boolean };
}

async function readPrivateObjects(batch: string, credentials: Record<string, string>) {
  const account = credentials.CLOUDFLARE_ACCOUNT_ID;
  const token = credentials.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !token || credentials.CLOUDFLARE_WORKERS_SUBDOMAIN !== "heocr") {
    throw new Error("expected HeOCR Cloudflare configuration");
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}`;
  const request = (suffix: string) => fetch(base + suffix, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  async function get<T>(suffix: string): Promise<CloudflareResponse<T>> {
    const response = await request(suffix);
    if (!response.ok) throw new Error(`private R2 readback returned HTTP ${response.status}`);
    const envelope = await response.json() as CloudflareResponse<T>;
    if (envelope.success !== true) throw new Error("private R2 readback failed");
    return envelope;
  }
  const [{ result: managed }, { result: custom }] = await Promise.all([
    get<{ enabled: boolean; domain: string }>("/domains/managed"), get<{ domains: unknown[] }>("/domains/custom"),
  ]);
  if (!Array.isArray(custom?.domains) || custom.domains.length !== 0) {
    throw new Error("private R2 public-access settings did not pass");
  }
  const managedUrl = disabledR2FixtureUrl(managed, accessFixture.key);
  const s3Url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${encodeURIComponent(accessFixture.key)}`);
  const fixture = await request(`/objects/${accessFixture.key}`);
  if (!fixture.ok || await fixture.text() !== accessFixture.text) throw new Error("private R2 access fixture could not be read");
  const anonymousProbes = await assertAnonymousR2Denial(managedUrl, s3Url);

  const objects: ObjectReadback[] = [];
  const cursors = new Set<string>();
  const query = new URLSearchParams({ prefix: batch + "/", per_page: "1000" });
  for (;;) {
    const { result, result_info: page } = await get<ObjectReadback[]>(`/objects?${query}`);
    if (!Array.isArray(result)) throw new Error("private R2 object listing was malformed");
    objects.push(...result);
    if (!page?.is_truncated) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("private R2 object listing pagination failed");
    cursors.add(page.cursor);
    query.set("cursor", page.cursor);
  }
  return { objects, anonymousProbes };
}

function readback(pins: RestrictedPins) {
  return d1Query<{
    status: string; restricted_reference: number; pages: number; lines: number; roster: number; plants: number;
    decisions: number; bad_media: number; pins_match: number; mode: string; pointed_books: string;
  }>("production", `SELECT b.status, b.restricted_reference, s.mode, s.pointed_books,
    (SELECT COUNT(*) FROM items WHERE batch_id=b.id) AS pages,
    (SELECT COUNT(*) FROM proposals WHERE batch_id=b.id AND active=1 AND gate_kind IS NULL
      AND json_extract(payload_json,'$.pass')=1) AS lines,
    (SELECT COUNT(*) FROM restricted_reference_pages r JOIN items i ON i.id=r.item_id AND i.batch_id=b.id
      WHERE r.batch_id=b.id AND r.first_allowed=1 AND r.blind_allowed=0 AND r.coverage_boxes_json IS NULL) AS roster,
    (SELECT COUNT(*) FROM triage_plants WHERE batch_id=b.id AND plants_sha256 IS ${lit(pins.plantsSha)}) AS plants,
    (SELECT COUNT(*) FROM decisions d JOIN proposals p ON p.id=d.proposal_id WHERE p.batch_id=b.id) AS decisions,
    ((SELECT COUNT(*) FROM proposals WHERE batch_id=b.id AND
        (active<>1 OR json_extract(payload_json,'$.pass') IS NOT 1 OR gate_kind IS NOT NULL
        OR json_extract(media_json,'$.crop.ref.source') IS NOT 'r2' OR json_extract(media_json,'$.page.ref.source') IS NOT 'r2'))
      + (SELECT COUNT(*) FROM items WHERE batch_id=b.id AND json_extract(payload_json,'$.page_image.ref.source') IS NOT 'r2')
      + (SELECT COUNT(*) FROM triage_plants WHERE batch_id=b.id AND plants_sha256 IS NOT ${lit(pins.plantsSha)})
      + (SELECT COUNT(*) FROM restricted_reference_pages WHERE batch_id=b.id AND (first_allowed<>1 OR blind_allowed<>0 OR coverage_boxes_json IS NOT NULL))
    ) AS bad_media,
    (json_extract(b.source_json,'$.items_sha256')=${lit(pins.itemsSha)}
      AND json_extract(b.source_json,'$.plants_sha256') IS ${lit(pins.plantsSha)}
      AND json_extract(b.source_json,'$.restricted_review') IS ${lit(pins.plantsSha === null ? DRAFT_VERIFICATION : null)}) AS pins_match
    FROM batches b LEFT JOIN batch_settings s ON s.batch_id=b.id WHERE b.id=${lit(pins.batch)};`)[0]?.[0];
}

function stageMatches(pins: RestrictedPins, row: ReturnType<typeof readback>) {
  return row?.status === "closed" && row.restricted_reference === 1 && row.mode === (pins.plantsSha === null ? "standard" : "triage") && row.pointed_books === "keep" &&
    row.pages === pins.pages && row.roster === pins.pages && row.lines === pins.lines && row.plants === pins.plants &&
    row.decisions === 0 && row.bad_media === 0 && row.pins_match === 1;
}

function verifyStoredRefs(stage: RestrictedImport, prepared: Awaited<ReturnType<typeof prepareRestrictedMedia>>): void {
  const batch = lit(stage.pins.batch);
  const [pages, lines, plants] = d1Query<{
    id: string; page_key: string; parent: string; crop_key: string; content_sha: string; rank: number;
    candidate_sha: string; planted_sha: string; plant_type: string; position: string;
  }>("production", `SELECT i.external_id AS id, json_extract(i.payload_json,'$.page_image.ref.key') AS page_key
    FROM items i JOIN restricted_reference_pages r ON r.item_id=i.id AND r.batch_id=i.batch_id WHERE i.batch_id=${batch};
    SELECT p.external_id AS id, i.external_id AS parent, p.content_sha256 AS content_sha, p.rank,
      json_extract(p.media_json,'$.page.ref.key') AS page_key, json_extract(p.media_json,'$.crop.ref.key') AS crop_key
    FROM proposals p JOIN items i ON i.id=p.item_id WHERE p.batch_id=${batch} AND i.batch_id=p.batch_id;
    SELECT item_id AS id, candidate_sha256 AS candidate_sha, planted_sha256 AS planted_sha, plant_type, position
    FROM triage_plants WHERE batch_id=${batch};`);
  const pageKeys = new Map(pages?.map((row) => [row.id, row]));
  const lineKeys = new Map(lines?.map((row) => [row.id, row]));
  const plantKeys = new Map(plants?.map((row) => [row.id, row]));
  const pinnedPlants = new Set(stage.plants.rows.map(row => row.item_id));
  const key = (image: StoredImage | undefined) => image?.ref.source === "r2" ? image.ref.key : undefined;
  if (pageKeys.size !== stage.pins.pages || lineKeys.size !== stage.pins.lines || plantKeys.size !== stage.pins.plants ||
    !stage.bundle.items.every((page) => pageKeys.get(page.externalId)?.page_key === key(prepared.itemImages.get(page.externalId))) ||
    !stage.bundle.proposals.every((line) => {
      const stored = lineKeys.get(line.externalId);
      const media = prepared.media.get(line.externalId);
      const { originalSha, correction } = importProposalContent(stage.bundle.batch.taskType, line, pinnedPlants.has(line.externalId));
      return stored && stored.parent === line.itemExternalId && stored.rank === line.rank &&
        stored.content_sha === (correction?.contentSha256 ?? originalSha) && stored.page_key === key(media?.page) && stored.crop_key === key(media?.crop);
    }) ||
    !stage.plants.rows.every((plant) => {
      const stored = plantKeys.get(plant.item_id);
      return stored && stored.candidate_sha === plant.candidate_sha256 && stored.planted_sha === plant.planted_sha256 &&
        stored.plant_type === plant.plant_type && stored.position === plant.position;
    })) {
    throw new Error("production roster, private object keys or plant entries differ from the pins; hold activation");
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const destination = target(flags);
  const verification = flags["verify-drafts"] === true;
  if (verification && ["plants", "plants-sha256", "plant-count", "separate-blind-pages"].some((key) => key in flags)) {
    throw new Error("draft verification takes neither plant arguments nor a separate blind roster");
  }
  const mediaOut = typeof flags["media-out"] === "string" ? flags["media-out"] : undefined;
  if (destination === "production" && mediaOut) throw new Error("prepare offline media before production staging");
  const count = (key: string) => {
    const value = Number(str(flags, key));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${key} must be a nonnegative integer`);
    return value;
  };
  const pins: RestrictedPins = {
    batch: str(flags, "batch"),
    itemsSha: str(flags, "items-sha256"), plantsSha: verification ? null : str(flags, "plants-sha256"),
    pages: count("pages"), lines: count("lines"), plants: verification ? 0 : count("plant-count"),
    separateBlindPages: verification ? 0 : count("separate-blind-pages"),
  };
  const root = realpathSync(str(flags, "media-root"));
  const stage = await prepareRestrictedReferenceImport(
    readFileSync(str(flags, "items")), verification ? null : readFileSync(str(flags, "plants")), root, pins,
  );
  const counts = {
    pages: pins.pages, lines: pins.lines, separate_blind_page_checks: stage.separateBlindPages, items_sha256: pins.itemsSha,
    plants_sha256: pins.plantsSha, planted: stage.plants.rows.length, skipped_decided: 0, refused: 0,
  };

  if (destination === "local") {
    if (!mediaOut) return void console.log(JSON.stringify({ ...counts, production_written: false }));
    const parent = realpathSync(dirname(resolve(mediaOut)));
    const checkout = resolve(import.meta.dirname, "..");
    if (parent === checkout || parent.startsWith(checkout + sep) || parent === root || parent.startsWith(root + sep)) {
      throw new Error("media output must be a new private directory outside the checkout and source root");
    }
    const dir = join(parent, basename(resolve(mediaOut)));
    mkdirSync(dir, { mode: 0o700 });
    mkdirSync(join(dir, pins.batch), { mode: 0o700 });
    const prepared = await prepareRestrictedMedia(stage, (key, bytes) => {
      writeFileSync(join(dir, key), bytes, { mode: 0o600, flag: "wx" });
    });
    writeFileSync(join(dir, accessFixture.key), accessFixture.text, { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ...counts, private_media_objects: prepared.objects.size, production_written: false }));
    return;
  }

  const existing = readback(pins);
  if (existing && !stageMatches(pins, existing)) throw new Error("existing batch differs from the complete, closed pinned stage");
  const credentials = loadCredentials();
  const estimate = estimateImportWrites({ items: pins.pages, proposals: pins.lines, existingProposals: 0 }) + pins.pages * 3 + pins.plants * 3 + 8;
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "D1_DAILY_WRITE_BUDGET"]) {
    if (credentials[key]) process.env[key] = credentials[key];
  }
  if (!existing) await checkWriteBudget(destination, estimate, {});
  const prepared = await prepareRestrictedMedia(stage);
  const { objects, anonymousProbes } = await readPrivateObjects(pins.batch, credentials);
  const sql = buildRestrictedStageSql(stage, prepared, objects, new Date().toISOString());
  if (!existing) {
    const dir = mkdtempSync(join(tmpdir(), "restricted-review-stage-"));
    const path = join(dir, "stage.sql");
    try {
      writeFileSync(path, sql, { mode: 0o600, flag: "wx" });
      // Wrangler output can contain SQL literals. Keep it out of the operator's log.
      try { d1File(destination, path); } catch { throw new Error("restricted D1 staging failed; inspect the protected database readback"); }
    } finally {
      unlinkSync(path);
      rmdirSync(dir);
    }
  }
  if (!stageMatches(pins, readback(pins))) throw new Error("production closed-stage readback differs; hold activation");
  verifyStoredRefs(stage, prepared);
  console.log(JSON.stringify({
    ...counts, private_media_objects_verified: prepared.objects.size, anonymous_probes: anonymousProbes,
    status: "closed", already_staged: !!existing,
  }));
}

main().catch((error: unknown) => {
  // Filesystem and JSON parser failures can name private paths or quote input bytes.
  console.error(error instanceof Error && !(error instanceof SyntaxError) && !("code" in error) ? error.message : "restricted input or staging I/O failed");
  process.exitCode = 1;
});
