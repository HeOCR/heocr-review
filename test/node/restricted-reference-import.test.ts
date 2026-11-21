import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { lineVerifyImporter } from "../../src/tasks/line_verify/importer";
import { digest, prepareRestrictedReferenceImport } from "../../scripts/lib/restricted-reference-import";
import { assertAnonymousR2Denial, buildRestrictedStageSql, disabledR2FixtureUrl, prepareRestrictedMedia } from "../../scripts/lib/restricted-reference-stage";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const batch = "private-ref-fixture-import";
const candidate = "A\u0301 ב";

it("probes only the disabled managed R2 hostname for anonymous object denial", () => {
  const domain = "pub-fixture.r2.dev";
  expect(disabledR2FixtureUrl({ enabled: false, domain }, "access-check.txt").href)
    .toBe("https://pub-fixture.r2.dev/access-check.txt");
  expect(() => disabledR2FixtureUrl({ enabled: true, domain }, "access-check.txt")).toThrow(/disabled/);
  expect(() => disabledR2FixtureUrl({ enabled: false, domain: domain + ".example.com" }, "access-check.txt")).toThrow(/disabled/);
  for (const status of [401, 403, 404]) expect(() => assertAnonymousR2Denial(status)).not.toThrow();
  for (const status of [200, 206, 302, 400, 500]) expect(() => assertAnonymousR2Denial(status)).toThrow(/unexpected/);
});
let root: string;
let raster: Buffer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "restricted-import-test-"));
  mkdirSync(join(root, "pages"));
  raster = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#f5eddb" } }).png().toBuffer();
  writeFileSync(join(root, "pages", "fixture.png"), raster);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function projection() {
  const page = {
    page_id: "p1", image: "pages/fixture.png", sha256: digest(raster), width: 40, height: 60,
    split: "test", source: "fixture", booklet: "source-A", book_group: "group-source-A",
  };
  return {
    schema_version: "line_verify_items.v1.2",
    batch_id: batch,
    blind_second_pass: [page.page_id],
    pages: [page],
    items: [
      {
        item_id: "typed-line", page_id: page.page_id, kind: "type", pass: 1, split: "test", rank: 41, line_index: 1,
        candidate_text: null, candidate_provenance: null, box: [5, 32, 28, 39], context_box: [1, 27, 38, 49],
        attention_spans: [], alignment_score: null, difficulty: 0.1, stratum: "fixture",
      },
      {
        item_id: "verify-line", page_id: page.page_id, kind: "verify", pass: 1, split: "test", rank: 7, line_index: 0,
        candidate_text: candidate, candidate_provenance: "pdf_text_layer", box: [5, 12, 28, 17], context_box: [1, 7, 38, 24],
        attention_spans: [], alignment_score: 0.8, difficulty: 0.2, stratum: "fixture",
      },
    ],
  };
}

function files(items = projection(), plantedText = "בדיקה") {
  const itemsBytes = encode(items);
  const itemsSha = digest(itemsBytes);
  const plantsBytes = encode({
    schema: "triage_plants.v1", bundle_sha256: itemsSha, plants: [{
      item_id: "verify-line", type: "fixture", position: ["ins", 1], planted_text: plantedText,
      planted_sha256: digest(Buffer.from(plantedText)), candidate_sha256: digest(Buffer.from(candidate)),
    }],
  });
  return {
    itemsBytes, plantsBytes,
    pins: { batch, itemsSha, plantsSha: digest(plantsBytes), pages: 1, lines: 2, plants: 1, separateBlindPages: 1 },
  };
}

it("preserves pins, exact candidate bytes, source grouping, ranks, boxes and first-pass content keys", async () => {
  const input = projection();
  const { itemsBytes, plantsBytes, pins } = files(input);
  const result = await prepareRestrictedReferenceImport(itemsBytes, plantsBytes, root, pins);
  const [verify, typing] = result.bundle.proposals;
  const normalMapping = lineVerifyImporter.bundle({ ...input, blind_second_pass: [] });
  expect(result.bundle.proposals.map(({ rank, gate }) => [rank, gate])).toEqual([[7, undefined], [41, undefined]]);
  expect(verify!.contentKey).toEqual(normalMapping.proposals[0]!.contentKey);
  expect(verify!.pageBox).toEqual(normalMapping.proposals[0]!.pageBox);
  expect(verify!.contextBox).toEqual(normalMapping.proposals[0]!.contextBox);
  expect(verify!.payload).toMatchObject({ pass: 1, candidate_text: candidate, candidate_provenance: "pdf_text_layer", blind: false });
  expect(typing!.payload).toMatchObject({ pass: 1, kind: "type", candidate_text: "" });
  const page = JSON.parse(JSON.stringify(result.bundle.items[0]!.payload));
  expect(page).toMatchObject({
    image_sha256: digest(raster), width: 40, height: 60,
    booklet: "source-A", book_group: "group-source-A", restricted_partition: "test",
  });
  expect(page).not.toHaveProperty("text_license");
  expect(page).not.toHaveProperty("segmenter");
  expect(page).not.toHaveProperty("book_title");
  expect(result.separateBlindPages).toBe(1);
  expect(result.plants.rows[0]).toMatchObject({ item_id: "verify-line", position: '["ins",1]' });
});

it.each([
  ["page roster", (p: ReturnType<typeof projection>) => { p.pages.push(p.pages[0]!); }, /roster/],
  ["duplicate item IDs", (p: ReturnType<typeof projection>) => { p.items[0]!.item_id = p.items[1]!.item_id; }, /item ID/],
  ["duplicate ranks", (p: ReturnType<typeof projection>) => { p.items[0]!.rank = p.items[1]!.rank; }, /rank/],
  ["train scope", (p: ReturnType<typeof projection>) => { p.pages[0]!.split = "train"; }, /outside test/],
  ["pass two", (p: ReturnType<typeof projection>) => { p.items[0]!.pass = 2; }, /first pass/],
  ["blind line IDs", (p: ReturnType<typeof projection>) => { p.blind_second_pass = [p.items[0]!.item_id]; }, /separate page/],
  ["empty line boxes", (p: ReturnType<typeof projection>) => { p.items[0]!.box[2] = p.items[0]!.box[0]!; }, /geometry/],
  ["context clipping a line", (p: ReturnType<typeof projection>) => { p.items[0]!.context_box[0] = 7; }, /geometry/],
  ["unapproved provenance", (p: ReturnType<typeof projection>) => { p.items[1]!.candidate_provenance = "unapproved"; }, /provenance/],
  ["unsafe media path", (p: ReturnType<typeof projection>) => { p.pages[0]!.image = "pages/../fixture.png"; }, /media pin/],
  ["wrong page digest", (p: ReturnType<typeof projection>) => { p.pages[0]!.sha256 = "f".repeat(64); }, /page bytes/],
  ["wrong dimensions", (p: ReturnType<typeof projection>) => { p.pages[0]!.height += 1; }, /dimensions/],
] as const)("refuses %s even with valid file pins", async (_case, change, error) => {
  const items = projection();
  change(items);
  const { itemsBytes, plantsBytes, pins } = files(items);
  await expect(prepareRestrictedReferenceImport(itemsBytes, plantsBytes, root, pins)).rejects.toThrow(error);
});

it("refuses both bad file pins, out-of-root media and an invalid plant", async () => {
  const { itemsBytes, plantsBytes, pins } = files();
  await expect(prepareRestrictedReferenceImport(itemsBytes, plantsBytes, root, { ...pins, itemsSha: "0".repeat(64) })).rejects.toThrow(/items checksum/);
  await expect(prepareRestrictedReferenceImport(itemsBytes, plantsBytes, root, { ...pins, plantsSha: "0".repeat(64) })).rejects.toThrow(/plants checksum/);
  const invalid = files(projection(), "A\u0301");
  await expect(prepareRestrictedReferenceImport(invalid.itemsBytes, invalid.plantsBytes, root, invalid.pins)).rejects.toThrow(/refused 1/);
  const items = projection();
  items.pages[0]!.image = "pages/link.png";
  writeFileSync(join(root, "outside.png"), raster);
  symlinkSync(join(root, "outside.png"), join(root, "pages", "link.png"));
  const linked = files(items);
  await expect(prepareRestrictedReferenceImport(linked.itemsBytes, linked.plantsBytes, root, linked.pins)).rejects.toThrow(/escaped/);
});

it("installs only a closed restricted first-pass roster and plants after verifying every private media ref", async () => {
  const { itemsBytes, plantsBytes, pins } = files();
  const stage = await prepareRestrictedReferenceImport(itemsBytes, plantsBytes, root, pins);
  const outputs = new Map<string, Buffer>();
  const media = await prepareRestrictedMedia(stage, (key, bytes) => outputs.set(key, bytes));
  expect([...outputs.keys()].every((key) => key.startsWith(batch + "/"))).toBe(true);
  expect([...outputs].every(([key, bytes]) => key.split("/")[1]!.startsWith(digest(bytes)))).toBe(true);
  const now = new Date().toISOString();
  expect(() => buildRestrictedStageSql(stage, media, [], now)).toThrow(/readback/);
  const readback = [...media.objects.values()];
  expect(() => buildRestrictedStageSql(stage, media, readback.map((row) => ({ ...row, etag: "bad" })), now)).toThrow(/readback/);
  const sql = buildRestrictedStageSql(stage, media, readback, now);
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync("migrations").sort()) db.exec(readFileSync(join("migrations", file), "utf8"));
    db.exec(sql);
    expect(db.prepare("SELECT status, restricted_reference FROM batches").get()).toEqual({ status: "closed", restricted_reference: 1 });
    expect(db.prepare("SELECT first_allowed, blind_allowed FROM restricted_reference_pages").all()).toEqual([{ first_allowed: 1, blind_allowed: 0 }]);
    expect(db.prepare("SELECT rank, gate_kind, json_extract(media_json,'$.crop.ref.source') AS crop FROM proposals ORDER BY rank").all())
      .toEqual([{ rank: 7, gate_kind: null, crop: "r2" }, { rank: 41, gate_kind: null, crop: "r2" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM decisions").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT plants_sha256, position FROM triage_plants").get()).toEqual({ plants_sha256: pins.plantsSha, position: '["ins",1]' });
    expect(() => db.exec(sql)).toThrow(/UNIQUE constraint failed/);
  } finally {
    db.close();
  }
});
