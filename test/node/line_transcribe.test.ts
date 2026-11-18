import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { joinsOf, normalizeTranscription, requiredLanguages, splitDisagreement } from "../../src/tasks/line_transcribe";
import { lineTranscribeImporter } from "../../src/tasks/line_transcribe/importer";
import { H_MANIFESTS, MANIFEST_FILES, REGISTERED_SHA256, agreementAction, hLineItemsProblems } from "../../src/tasks/line_transcribe/schema";

const DIR = "test/fixtures/line_transcribe";
const FIXTURE = `${DIR}/h_line_items_v1.json`;
type Raw = { manifest_sha256: Record<string, string>; pages: Record<string, unknown>[] };
const raw = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as Raw;
const jsonl = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const sidecars = () => Object.fromEntries(Object.values(MANIFEST_FILES).map((f) => [f, jsonl(`${DIR}/${f}`)]));

describe("h_line_items.v1", () => {
  it("accepts the fixture with its manifests and imports one line per box, with no text", () => {
    expect(hLineItemsProblems(raw(), sidecars())).toEqual([]);
    const b = lineTranscribeImporter.bundle(raw(), sidecars(), { "h_line_items_v1.json": "f".repeat(64) });
    expect(b.proposals).toHaveLength(5);
    expect(b.proposals.every((p) => (p.payload as { prefill: string }).prefill === "")).toBe(true);
    expect(b.batch.source).toMatchObject({ gate_batch_id: "newprinted_midcentury_volunteers_v0", sources: { "h_line_items_v1.json": "f".repeat(64) } });
  });

  it("holds out no_hebrew_text pages and pages with no box", () => {
    const b = lineTranscribeImporter.bundle(raw(), sidecars());
    expect((b.batch.source as { held_pages: unknown }).held_pages).toEqual([
      { page_key: "nli__fixture005__p0001", reason: "no_hebrew_text" },
      { page_key: "nli__fixture006__p0004", reason: "no_boxes" },
    ]);
    expect(b.items.map((i) => i.externalId)).not.toContain("nli__fixture005__p0001");
  });

  it("takes languages from the manifest, credits only the institution, and shows the whole row around a line", () => {
    const b = lineTranscribeImporter.bundle(raw(), sidecars());
    const jrb = b.proposals.find((p) => p.externalId === "nli__fixture003__p0002#l0")!.payload as { languages: string[]; attribution: string; context_box: number[] };
    expect(jrb.languages).toEqual(["he", "jrb"]);
    expect(jrb.attribution).toBe("Fixture Library");
    expect(jrb.context_box[0]).toBe(0);
    expect(jrb.context_box[2]).toBe(1);
    expect(b.items[0]!.bundleImage!.path).toBe("data/scans/loc__fixture001__p0001.jpg");
  });

  it("refuses every box file until eval registers one; the manifests are registered", () => {
    expect(REGISTERED_SHA256).toEqual({});
    expect(lineTranscribeImporter.mustBeRegistered).toEqual(["h_line_items_v1.json", ...Object.values(MANIFEST_FILES)]);
    expect(lineTranscribeImporter.registeredSha256).toEqual({ "h_eval_v1/manifest.jsonl": H_MANIFESTS.h_eval_v1, "h_eval_v1_1/manifest.jsonl": H_MANIFESTS.h_eval_v1_1 });
  });

  it("refuses a missing or other manifest, a page the manifest disagrees with, typed text and boxes off the page", () => {
    expect(hLineItemsProblems(raw(), {}).some((p) => p.includes("h_eval_v1/manifest.jsonl"))).toBe(true);
    const bad = raw();
    bad.manifest_sha256.h_eval_v1 = "0".repeat(64);
    bad.pages[0]!.stratum = "seen_writer";
    bad.pages[2]!.image_sha256 = "3".repeat(64);
    bad.pages[3]!.page_key = "nli__fixture999__p0001";
    (bad.pages[1]!.lines as { box: number[]; prefill: string }[])[0]!.box = [0, 0, 2000, 10];
    (bad.pages[0]!.lines as { prefill: string }[])[1]!.prefill = "בדוי";
    const problems = hLineItemsProblems(bad, sidecars());
    expect(problems.some((p) => p.includes("manifest_sha256.h_eval_v1"))).toBe(true);
    expect(problems.some((p) => p.includes("pages[0].stratum differs"))).toBe(true);
    expect(problems.some((p) => p.includes("pages[2].image_sha256 differs"))).toBe(true);
    expect(problems.some((p) => p.includes("nli__fixture999__p0001 is in neither"))).toBe(true);
    expect(problems.some((p) => p.includes("inside the page image"))).toBe(true);
    expect(problems.some((p) => p.includes("prefill must be empty"))).toBe(true);
  });

  it("refuses an other-script page whose manifest lists no other language", () => {
    const side = sidecars();
    const rows = side["h_eval_v1_1/manifest.jsonl"] as { entry_id: string; languages: string[] }[];
    rows.find((r) => r.entry_id === "nli__fixture003__p0002")!.languages = ["he"];
    expect(hLineItemsProblems(raw(), side).some((p) => p.includes("lists no language besides he"))).toBe(true);
  });
});

describe("box problems", () => {
  it("count a split line read two ways as a split disagreement", () => {
    const t = (text: string) => ({ value: "edit", text });
    expect(splitDisagreement(t("שורה בדויה ארוכה"), { value: "continued", text: null })).toBe(true);
    expect(splitDisagreement(t("שורה בדויה ארוכה"), t("שורה בדויה"))).toBe(true);
    expect(splitDisagreement(t("שורה בדויה"), t("שורה אחרת"))).toBe(false);
    expect(splitDisagreement({ value: "no_text", text: null }, { value: "continued", text: null })).toBe(false);
  });

  it("are all not_on_page for agreement.py, with the reason kept", () => {
    expect(agreementAction("no_text")).toBe("not_on_page");
    expect(agreementAction("continued")).toBe("not_on_page");
    expect(agreementAction("not_on_page")).toBe("not_on_page");
    expect(agreementAction("edit")).toBe("edit");
  });

  it("join a continued piece to the nearest piece on its right in the row that can hold the line, whatever the box order", () => {
    type Role = "continued" | "box_problem" | "line";
    const L = (i: number, box: [number, number, number, number], role: Role) => ({ page_key: "p", i, box, role });
    const lines = [
      // One row split in three, numbered out of order.
      L(0, [100, 100, 300, 160], "continued"),
      L(1, [650, 105, 900, 165], "line"),
      L(2, [320, 98, 630, 158], "continued"),
      // A whole row.
      L(3, [100, 200, 900, 260], "line"),
      // A continued piece whose right neighbour was marked no text: unattached, not joined to it or across rows.
      L(4, [100, 300, 400, 360], "continued"),
      L(5, [450, 300, 900, 360], "box_problem"),
    ];
    expect(joinsOf(lines)).toEqual([
      { page_key: "p", first: null, pieces: [4], reason: "unattached" },
      { page_key: "p", first: 1, pieces: [0, 2], reason: null },
    ]);
  });
});

describe("transcriptions", () => {
  it("are typed: no correct, no empty or span-only text, letters only with the niqqud mark", () => {
    expect(normalizeTranscription("correct", undefined).ok).toBe(false);
    expect(normalizeTranscription("edit", "").ok).toBe(false);
    expect(normalizeTranscription("edit", " [?] ").ok).toBe(false);
    expect(normalizeTranscription("print_has_niqqud", "שָׁ").ok).toBe(false);
    expect(normalizeTranscription("unreadable", "x").ok).toBe(false);
    expect(normalizeTranscription("edit", " בדוי [?] ")).toEqual({ ok: true, value: "edit", text: "בדוי [?]" });
    expect(normalizeTranscription("not_on_page", null)).toEqual({ ok: true, value: "not_on_page", text: null });
    expect(normalizeTranscription("continued", undefined)).toEqual({ ok: true, value: "continued", text: null });
    expect(normalizeTranscription("no_text", null)).toEqual({ ok: true, value: "no_text", text: null });
    expect(normalizeTranscription("continued", "בדוי").ok).toBe(false);
  });

  it("other-script lines need their languages besides Hebrew; other strata need none", () => {
    expect(requiredLanguages({ stratum: "other_hebrew_script", languages: ["he", "jrb", "ar"] })).toEqual(["jrb", "ar"]);
    expect(requiredLanguages({ stratum: "primary", languages: ["he", "jrb"] })).toEqual([]);
  });
});

describe("terms for transcription", () => {
  it("cover it only from TRANSCRIBE_TERMS_VERSION on", async () => {
    const { TRANSCRIBE_TERMS_VERSION, termsCoverTranscription } = await import("../../src/tasks/line_transcribe/schema");
    const { TERMS_VERSION } = await import("../../src/shared/terms");
    expect(termsCoverTranscription(TERMS_VERSION)).toBe(TERMS_VERSION >= TRANSCRIBE_TERMS_VERSION);
    expect(termsCoverTranscription(null)).toBe(false);
    expect(termsCoverTranscription("2026-11-12-v1")).toBe(false);
    expect(termsCoverTranscription(TRANSCRIBE_TERMS_VERSION)).toBe(true);
  });
});

describe("page images", () => {
  // Each page is drawn in its displayed frame (200x120, white, a black mark at MARK), then stored as the camera would:
  // the pixels turned back and the EXIF orientation set. Stored upright, the mark must be where the box says.
  const W = 200;
  const H = 120;
  const MARK = { left: 130, top: 20, width: 50, height: 30 };
  /** sharp's clockwise turn that undoes each orientation's display turn (3: 180°, 6: 90° cw, 8: 90° ccw). */
  const STORE_TURN: Record<number, number> = { 1: 0, 3: 180, 6: 270, 8: 90 };

  it.each([1, 3, 6, 8])("orientation %i: the image is stored upright and the displayed-frame box lands on the mark", async (orientation) => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sharp = (await import("sharp")).default;
    const { readingPage } = await import("../../scripts/lib/media");
    const { boxes } = await import("../../src/tasks/line_consensus/importer");
    const displayed = await sharp({ create: { width: W, height: H, channels: 3, background: "#fff" } })
      .composite([{ input: { create: { width: MARK.width, height: MARK.height, channels: 3, background: "#000" } }, left: MARK.left, top: MARK.top }])
      .png()
      .toBuffer();
    const stored = await sharp(displayed).rotate(STORE_TURN[orientation]).jpeg({ quality: 95 }).withMetadata({ orientation }).toBuffer();
    expect((await sharp(stored).metadata()).orientation ?? 1).toBe(orientation);
    const dir = mkdtempSync(join(tmpdir(), "heocr-exif-"));
    const src = join(dir, `o${orientation}.jpg`);
    writeFileSync(src, stored);
    const page = await readingPage(dir, "b", `p${orientation}`, src, { width: W, height: H });
    expect([page.width, page.height]).toEqual([W, H]);
    if (page.ref.source !== "static") throw new Error("expected a static page image");
    const out = sharp(join(dir, page.ref.path));
    expect([(await out.metadata()).width, (await out.metadata()).height, (await out.metadata()).orientation ?? 1]).toEqual([W, H, 1]);
    const { data, info } = await out.greyscale().raw().toBuffer({ resolveWithObject: true });
    const at = (fx: number, fy: number) => data[Math.floor(fy * info.height) * info.width + Math.floor(fx * info.width)]!;
    // The box as the importer stores it (page fractions), from the mark in displayed pixels.
    const { pageBox } = boxes([MARK.left, MARK.top, MARK.left + MARK.width, MARK.top + MARK.height], [W, H]);
    expect(at((pageBox[0] + pageBox[2]) / 2, (pageBox[1] + pageBox[3]) / 2)).toBeLessThan(60);
    expect(at(0.1, 0.8)).toBeGreaterThan(200);
    // A declared size in the stored frame (unturned) is refused for the turned ones.
    if (orientation >= 5) await expect(readingPage(dir, "b", `q${orientation}`, src, { width: H, height: W })).rejects.toThrow(/as displayed/);
  });

  it("orientation 1 comes out byte for byte as before the change (nothing already imported would differ)", async () => {
    const { mkdtempSync, writeFileSync, readFileSync: read } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sharp = (await import("sharp")).default;
    const { readingPage, READING_PAGE_MAX_WIDTH } = await import("../../scripts/lib/media");
    const dir = mkdtempSync(join(tmpdir(), "heocr-exif1-"));
    const src = join(dir, "plain.jpg");
    writeFileSync(src, await sharp({ create: { width: 300, height: 400, channels: 3, background: "#eee" } }).jpeg().toBuffer());
    const page = await readingPage(dir, "b", "p", src);
    if (page.ref.source !== "static") throw new Error("expected a static page image");
    const before = await sharp(read(src)).resize({ width: Math.min(READING_PAGE_MAX_WIDTH, 300) }).greyscale().png({ palette: true, colors: 16, compressionLevel: 9 }).toBuffer();
    expect(read(join(dir, page.ref.path)).equals(before)).toBe(true);
  });
});
