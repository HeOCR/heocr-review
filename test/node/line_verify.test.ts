import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { contentSha256 } from "../../scripts/lib/importsql";
import { bundleImageProblems, cutLines, lineCropRect } from "../../scripts/lib/media";
import { attentionRuns } from "../../src/shared/attention";
import { sha256Hex } from "../../src/shared/sha256";
import { buildExport } from "../../src/tasks/export";
import { lineVerify, normalizeLineDecision } from "../../src/tasks/line_verify";
import { lineVerifyImporter } from "../../src/tasks/line_verify/importer";
import { decisionsFileProblems, itemsFileProblems, type LvItemsFile } from "../../src/tasks/line_verify/schema";
import type { BatchRecord, DecisionRecord, ProposalRecord } from "../../src/tasks/types";

const FIXTURE_DIR = "test/fixtures/line_verify";
const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "items.json"), "utf8")) as LvItemsFile;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** Shin, shin dot, qamats: not NFC (NFC puts the qamats, combining class 18, before the shin dot, 24). */
const UNORDERED = "\u05e9\u05c1\u05b8לום";

describe("line_verify_items.v1", () => {
  it("accepts the synthetic fixture", () => {
    expect(itemsFileProblems(fixture)).toEqual([]);
    expect(lineVerifyImporter.problems(fixture)).toEqual([]);
  });

  it.each([
    ["another schema", (f: any) => (f.schema_version = "line_verify_items.v2"), "schema_version"],
    ["a batch id unfit for a URL", (f: any) => (f.batch_id = "a b/c"), "batch_id"],
    ["a box outside the page", (f: any) => (f.items[0].box = [10, 10, 5000, 40]), "inside the page"],
    ["an inverted context box", (f: any) => (f.items[0].context_box = [50, 50, 10, 60]), "context_box"],
    ["a decomposed (non-NFC) candidate", (f: any) => (f.items[0].candidate_text = UNORDERED), "NFC"],
    ["a candidate with a line break", (f: any) => (f.items[0].candidate_text = "שורה\nשנייה"), "one line"],
    ["an empty candidate", (f: any) => (f.items[0].candidate_text = " "), "not be empty"],
    ["a span past the end", (f: any) => (f.items[0].attention_spans = [[0, 999]]), "attention_spans"],
    ["a reversed span", (f: any) => (f.items[0].attention_spans = [[3, 1]]), "attention_spans"],
    ["an unknown provenance", (f: any) => (f.items[0].candidate_provenance = "ocr"), "candidate_provenance"],
    ["an unknown source", (f: any) => (f.pages[0].source = "heocr_restricted"), "source must be one of"],
    ["a closed licence", (f: any) => (f.pages[0].text_license = "all rights reserved"), "open licence"],
    ["a missing attribution", (f: any) => (f.pages[0].attribution = ""), "attribution"],
    ["an image outside pages/", (f: any) => (f.pages[0].image = "../x.jpg"), "image must be"],
    ["a line on an unknown page", (f: any) => (f.items[0].page_id = "nope"), "not a page of this bundle"],
    ["a duplicate line", (f: any) => f.items.push(clone(f.items[0])), "listed twice"],
    ["a difficulty above 1", (f: any) => (f.items[0].difficulty = 1.5), "difficulty"],
    ["an unknown stratum", (f: any) => (f.items[0].stratum = "easy"), "stratum"],
  ])("refuses %s", (_, mutate, message) => {
    const f = clone(fixture);
    mutate(f);
    const problems = itemsFileProblems(f);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(message);
  });

  it("imports pages as items and lines as proposals, in rank order with ties by item_id", () => {
    const b = lineVerifyImporter.bundle(fixture);
    expect(b.batch).toMatchObject({ id: "fixture_line_verify_v1", taskType: "line_verify" });
    expect(b.items.map((i) => i.externalId)).toEqual(fixture.pages.map((p) => p.page_id));
    expect(b.items[0]!.bundleImage).toEqual({ path: fixture.pages[0]!.image, sha256: fixture.pages[0]!.sha256, width: 1400, height: 1500 });
    expect(b.proposals.map((p) => p.rank)).toEqual(b.proposals.map((_, i) => i));
    const ranks = b.proposals.map((p) => (p.payload as { bundle_rank: number }).bundle_rank);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    const tied = b.proposals.filter((p) => (p.payload as { bundle_rank: number }).bundle_rank === 5).map((p) => p.externalId);
    expect(tied).toEqual([...tied].sort());
    expect(tied).toHaveLength(2);
    const first = b.proposals[0]!;
    expect(first.category).toBe("hard");
    expect(first.confidence).toBe("wikisource_quality3_single_proofreader");
    const item = fixture.items.find((i) => i.item_id === first.externalId)!;
    expect(first.pageBox![0]).toBeCloseTo(item.box[0] / 1400, 5);
    expect(first.pageBox![3]).toBeCloseTo(item.box[3] / 1500, 5);
  });

  it("pins decisions to the text, the boxes and the scan", () => {
    const a = lineVerifyImporter.bundle(fixture).proposals[0]!;
    const f = clone(fixture);
    f.pages[0]!.sha256 = "0".repeat(64);
    const b = lineVerifyImporter.bundle(f).proposals[0]!;
    expect(contentSha256(a.contentKey)).not.toBe(contentSha256(b.contentKey));
    const g = clone(fixture);
    g.pages[0]!.attribution = "changed wording";
    expect(contentSha256(lineVerifyImporter.bundle(g).proposals[0]!.contentKey)).toBe(contentSha256(a.contentKey));
  });
});

describe("attention runs", () => {
  it("marks code-point spans", () => {
    expect(attentionRuns("אבג דהו", [[4, 7]])).toEqual([
      { text: "אבג ", attention: false },
      { text: "דהו", attention: true },
    ]);
  });

  it("widens a span to whole graphemes, so a mark never leaves its letter", () => {
    const text = "שָׁלוֹם"; // ש + qamats + shin dot, ...
    const runs = attentionRuns(text, [[1, 2]]); // only the qamats
    expect(runs[0]).toEqual({ text: Array.from(text).slice(0, 3).join(""), attention: true });
    expect(runs.map((r) => r.text).join("")).toBe(text);
  });

  it("shows an empty span as an insertion point, also at the end", () => {
    expect(attentionRuns("אב", [[2, 2]])).toEqual([
      { text: "אב", attention: false },
      { text: "", attention: true },
    ]);
    expect(attentionRuns("אב", [[1, 1]])).toEqual([
      { text: "א", attention: false },
      { text: "", attention: true },
      { text: "ב", attention: false },
    ]);
  });

  it("merges overlapping spans and survives out-of-range ones", () => {
    expect(attentionRuns("אבגד", [[0, 2], [1, 3], [9, 12]])).toEqual([
      { text: "אבג", attention: true },
      { text: "ד", attention: false },
    ]);
  });
});

describe("decisions", () => {
  const cand = "הילד הלך אל בית הספר בבוקר השכם.";

  it("carry no text except an edit", () => {
    expect(normalizeLineDecision(cand, "exact", undefined)).toEqual({ ok: true, value: "exact", text: null });
    expect(normalizeLineDecision(cand, "unreadable", null)).toEqual({ ok: true, value: "unreadable", text: null });
    expect(normalizeLineDecision(cand, "misaligned", undefined)).toEqual({ ok: true, value: "misaligned", text: null });
    expect(normalizeLineDecision(cand, "exact", "x").ok).toBe(false);
    expect(normalizeLineDecision(cand, "accepted", undefined).ok).toBe(false);
  });

  it("store an edit as NFC without edge whitespace; an edit equal to the candidate is exact", () => {
    const edited = "הילד הלך אל בית הספר בבקר השכם.";
    expect(normalizeLineDecision(cand, "edited", `  ${edited} `)).toEqual({ ok: true, value: "edited", text: edited });
    expect(UNORDERED).not.toBe(UNORDERED.normalize("NFC"));
    const r = normalizeLineDecision(cand, "edited", UNORDERED);
    expect(r).toEqual({ ok: true, value: "edited", text: UNORDERED.normalize("NFC") });
    expect(normalizeLineDecision(cand, "edited", ` ${cand}`)).toEqual({ ok: true, value: "exact", text: null });
  });

  it("refuse an empty, multi-line, oversized or missing edit", () => {
    for (const bad of ["", "   ", "א\nב", "א\tב", "א".repeat(1001), undefined, 5]) {
      expect(normalizeLineDecision(cand, "edited", bad).ok).toBe(false);
    }
  });
});

describe("export: line_verify_decisions.v1", () => {
  const bundle = lineVerifyImporter.bundle(fixture);
  const batch: BatchRecord = { id: bundle.batch.id, taskType: "line_verify", title: "t", source: bundle.batch.source, minReviewers: 1 };
  const proposals: ProposalRecord[] = bundle.proposals.map((p, i) => ({
    id: i + 1,
    batchId: batch.id,
    externalId: p.externalId,
    itemExternalId: p.itemExternalId,
    itemTitle: "",
    category: p.category,
    confidence: p.confidence,
    rank: p.rank,
    payload: p.payload,
    media: {},
    contentSha256: contentSha256(p.contentKey),
    active: true,
  }));
  const items = proposals.map((p) => ({ item_id: p.externalId, candidate_text: p.payload.candidate_text as string }));
  let n = 0;
  const decision = (proposalId: number, reviewerId: string, value: string, extra: Partial<DecisionRecord> = {}): DecisionRecord => ({
    id: `hr-${(++n).toString(16).padStart(16, "0")}`,
    proposalId,
    reviewerId,
    value,
    text: null,
    createdAt: `2026-11-07T10:00:${String(n).padStart(2, "0")}.000Z`,
    decidedOn: "2026-11-07",
    supersededAt: null,
    proposalSha256: proposals[proposalId - 1]!.contentSha256,
    termsVersion: "t1",
    ...extra,
  });

  it("writes the contract's keys in its order, in items.json order, and validates", () => {
    const decisions = [
      decision(1, "rv_bbbbbbbb", "edited", { text: "הילד הלך אל בית הספר בבקר השכם." }),
      decision(1, "rv_aaaaaaaa", "exact"),
      decision(2, "rv_aaaaaaaa", "unreadable"),
      decision(3, "rv_aaaaaaaa", "misaligned", { supersededAt: "2026-11-07T11:00:00.000Z" }),
      decision(4, "rv_aaaaaaaa", "exact", { proposalSha256: "f".repeat(64) }), // stale
    ];
    const r = buildExport({ batch, proposals, decisions, credits: [], exportedAt: "x" });
    expect(r.problems).toEqual([]);
    expect(r.decisionsFile.fileName).toBe("line_verify_decisions.json");
    expect(r.ledgerFile.fileName).toBe("line_verify_decisions_ledger.json");
    const content = r.decisionsFile.content as { schema_version: string; batch_id: string; decisions: Record<string, unknown>[] };
    expect(Object.keys(content)).toEqual(["schema_version", "batch_id", "decisions"]);
    expect(content).toMatchObject({ schema_version: "line_verify_decisions.v1", batch_id: "fixture_line_verify_v1" });
    for (const d of content.decisions) {
      expect(Object.keys(d)).toEqual(
        d.decision === "edited"
          ? ["decision_id", "item_id", "reviewer", "decision", "text", "candidate_sha256", "decided_at", "checked_by"]
          : ["decision_id", "item_id", "reviewer", "decision", "candidate_sha256", "decided_at", "checked_by"],
      );
      expect(d.decision_id).toBe(`decision:${String(d.item_id)}:${String(d.reviewer)}`);
      const cand = items.find((i) => i.item_id === d.item_id)!.candidate_text;
      expect(d.candidate_sha256).toBe(createHash("sha256").update(cand, "utf8").digest("hex"));
    }
    const order = (id: unknown) => fixture.items.findIndex((i) => i.item_id === id);
    const positions = content.decisions.map((d) => order(d.item_id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Proposal 1 (rank 0) comes before proposal 2 in items.json too; reviewers sorted within a line.
    expect(content.decisions.map((d) => [d.item_id, d.reviewer, d.decision])).toEqual([
      [proposals[0]!.externalId, "rv_aaaaaaaa", "exact"],
      [proposals[0]!.externalId, "rv_bbbbbbbb", "edited"],
      [proposals[1]!.externalId, "rv_aaaaaaaa", "unreadable"],
    ]);
    expect(r.counts).toMatchObject({ decisions_exported: 3, conflict: 1, agreed: 1, decisions_stale: 1 });
    expect(lineVerify.validateExport(batch, proposals, content)).toEqual([]);
  });

  it("refuses text on a non-edit, an edit equal to the candidate, a wrong id, hash or reviewer", () => {
    const base = { decision_id: `decision:${items[0]!.item_id}:rv_aaaaaaaa`, item_id: items[0]!.item_id, reviewer: "rv_aaaaaaaa", decided_at: "2026-11-07", checked_by: "human" };
    const file = (d: Record<string, unknown>) => ({ schema_version: "line_verify_decisions.v1", batch_id: batch.id, decisions: [{ ...base, ...d }] });
    const check = (d: Record<string, unknown>) => decisionsFileProblems(file(d), batch.id, items).join("\n");
    expect(check({ decision: "exact" })).toBe("");
    expect(check({ decision: "exact", text: "x" })).toContain("only an edited decision");
    expect(check({ decision: "edited", text: items[0]!.candidate_text })).toContain("record exact");
    expect(check({ decision: "edited" })).toContain("text must be a string");
    expect(check({ decision: "maybe" })).toContain("decision must be one of");
    expect(check({ decision: "exact", decision_id: "d1" })).toContain("decision:<item_id>:<reviewer>");
    expect(check({ decision: "exact", reviewer: "Shay", decision_id: `decision:${items[0]!.item_id}:Shay` })).toContain("pseudonymous");
    expect(check({ decision: "exact", item_id: "nope", decision_id: "decision:nope:rv_aaaaaaaa" })).toContain("not an item");
    const withSha = [{ ...items[0]!, candidate_sha256: sha256Hex(items[0]!.candidate_text) }];
    expect(decisionsFileProblems(file({ decision: "exact", candidate_sha256: "0".repeat(64) }), batch.id, withSha).join()).toContain("not the item's candidate_text");
  });
});

describe("sha256Hex", () => {
  it("matches node:crypto on UTF-8 text of any length", () => {
    for (const s of ["", "abc", "שָׁלוֹם", "x".repeat(55), "x".repeat(56), "y".repeat(64), "ז".repeat(700), "ﬠ😀"]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});

describe("line crops", () => {
  it("cut a rectangle around the line and its context band, inside the page", () => {
    const r = lineCropRect([0.4, 0.3, 0.9, 0.33], [0.35, 0.25, 0.92, 0.4], 1000, 2000);
    expect(r.left).toBeLessThanOrEqual(350);
    expect(r.top).toBeLessThanOrEqual(500);
    expect(r.left + r.width).toBeGreaterThanOrEqual(920);
    expect(r.top + r.height).toBeGreaterThanOrEqual(800);
    const edge = lineCropRect([0.9, 0.97, 1, 1], [0.9, 0.95, 1, 1], 1000, 2000);
    expect(edge.left + edge.width).toBeLessThanOrEqual(1000);
    expect(edge.top + edge.height).toBeLessThanOrEqual(2000);
  });

  it("are cut from the bundle's page with the line's box in crop coordinates", async () => {
    const out = mkdtempSync(join(tmpdir(), "lv-media-"));
    const page = fixture.pages[0]!;
    const lines = lineVerifyImporter.bundle(fixture).proposals.filter((p) => p.itemExternalId === page.page_id);
    const cut = await cutLines(out, fixture.batch_id, "p1", join(FIXTURE_DIR, page.image), page, lines.map((p) => ({ externalId: p.externalId, box: p.pageBox!, contextBox: p.contextBox! })));
    expect(cut.crops.size).toBe(lines.length);
    expect(cut.page.width).toBe(1000);
    for (const p of lines) {
      const crop = cut.crops.get(p.externalId)!;
      expect(crop.ref).toMatchObject({ source: "static" });
      const path = (crop.ref as { path: string }).path;
      expect(path).toMatch(/^media\/fixture_line_verify_v1\/p1\/.+-[0-9a-f]{10}\.jpg$/);
      const meta = await sharp(join(out, path)).metadata();
      expect([meta.width, meta.height]).toEqual([crop.width, crop.height]);
      const [x0, y0, x1, y1] = crop.box!;
      expect(0 <= x0 && x0 < x1 && x1 <= 1 && 0 <= y0 && y0 < y1 && y1 <= 1).toBe(true);
    }
  });

  it("refuse a page image whose checksum or size differs, or that lies outside the bundle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lv-bundle-"));
    mkdirSync(join(dir, "pages"));
    const page = fixture.pages[0]!;
    copyFileSync(join(FIXTURE_DIR, page.image), join(dir, page.image));
    const ref = { path: page.image, sha256: page.sha256 };
    expect(bundleImageProblems(dir, [ref])).toEqual([]);
    writeFileSync(join(dir, page.image), "changed");
    expect(bundleImageProblems(dir, [ref]).join()).toContain("checksum");
    expect(bundleImageProblems(dir, [{ path: "pages/missing.jpg", sha256: page.sha256 }]).join()).toContain("missing");
    const square = join(dir, "square.png");
    await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).png().toFile(square);
    await expect(cutLines(dir, "b", "s", square, { width: 1400, height: 1500 }, [])).rejects.toThrow(/items.json says/);
  });
});
