import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeTranscription, requiredLanguages } from "../../src/tasks/line_transcribe";
import { lineTranscribeImporter } from "../../src/tasks/line_transcribe/importer";
import { REGISTERED_SHA256, hLineItemsProblems } from "../../src/tasks/line_transcribe/schema";

const FIXTURE = "test/fixtures/line_transcribe/h_line_items_v1.json";
const raw = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as { manifests: Record<string, string>; pages: Record<string, unknown>[] };

describe("h_line_items.v1", () => {
  it("accepts the fixture and imports one line per box, with no text", () => {
    expect(hLineItemsProblems(raw())).toEqual([]);
    const b = lineTranscribeImporter.bundle(raw(), {}, { "h_line_items_v1.json": "f".repeat(64) });
    expect(b.proposals).toHaveLength(5);
    expect(b.proposals.every((p) => (p.payload as { prefill: string }).prefill === "")).toBe(true);
    expect(b.batch.source).toMatchObject({ gate_batch_id: "newprinted_midcentury_volunteers_v0", sources: { "h_line_items_v1.json": "f".repeat(64) } });
  });

  it("refuses every box file until eval registers one", () => {
    expect(REGISTERED_SHA256).toEqual({});
    expect(lineTranscribeImporter.mustBeRegistered).toContain("h_line_items_v1.json");
  });

  it("refuses an unregistered manifest, an unknown stratum, other-script pages with no language, and boxes off the page", () => {
    const bad = raw();
    bad.manifests.h_eval_v1 = "0".repeat(64);
    bad.pages[0]!.stratum = "secondary";
    bad.pages[2]!.languages = ["he"];
    (bad.pages[1]!.lines as { box: number[] }[])[0]!.box = [0, 0, 2000, 10];
    const problems = hLineItemsProblems(bad);
    expect(problems.some((p) => p.includes("manifests.h_eval_v1"))).toBe(true);
    expect(problems.some((p) => p.includes("pages[0].stratum"))).toBe(true);
    expect(problems.some((p) => p.includes("pages[2] is other_hebrew_script"))).toBe(true);
    expect(problems.some((p) => p.includes("inside the page image"))).toBe(true);
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
