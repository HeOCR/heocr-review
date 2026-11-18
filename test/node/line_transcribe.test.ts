import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { joinsOf, normalizeTranscription, requiredLanguages } from "../../src/tasks/line_transcribe";
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
  it("are stored upright (EXIF orientation applied), so boxes in the displayed frame line up", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const sharp = (await import("sharp")).default;
    const { readingPage } = await import("../../scripts/lib/media");
    const dir = mkdtempSync(join(tmpdir(), "heocr-exif-"));
    // Stored 40x20, shown 20x40 (orientation 8: rotate 90° counter-clockwise).
    const src = join(dir, "turned.jpg");
    writeFileSync(src, await sharp({ create: { width: 40, height: 20, channels: 3, background: "#fff" } }).jpeg().withMetadata({ orientation: 8 }).toBuffer());
    const page = await readingPage(dir, "b", "p", src, { width: 20, height: 40 });
    expect([page.width, page.height]).toEqual([20, 40]);
    if (page.ref.source !== "static") throw new Error("expected a static page image");
    const meta = await sharp(join(dir, page.ref.path)).metadata();
    expect([meta.width, meta.height, meta.orientation ?? 1]).toEqual([20, 40, 1]);
    await expect(readingPage(dir, "b", "q", src, { width: 40, height: 20 })).rejects.toThrow(/as displayed/);
  });
});
