import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentSha256 } from "../../scripts/lib/importsql";
import { buildExport } from "../../src/tasks/export";
import { normalizeLineDecision, payloadOf } from "../../src/tasks/line_consensus";
import { boxes, lineConsensusImporter, seriesOf } from "../../src/tasks/line_consensus/importer";
import type { BatchRecord, DecisionRecord, ProposalRecord } from "../../src/tasks/types";

const DIR = "test/fixtures/line_consensus";
const read = (n: string) => JSON.parse(readFileSync(`${DIR}/${n}`, "utf8")) as Record<string, unknown>;
const items = () => read("line_items_v1.json");
const sidecars = (over: Record<string, unknown> = {}) => ({
  "volunteer_exclusions_v1.json": read("volunteer_exclusions_v1.json"),
  "maintainer_decided.json": read("maintainer_decided.json"),
  "ai_flags.json": read("ai_flags.json"),
  "gold_v1.json": read("gold_v1.json"),
  ...over,
});
const A = "plenary:K1_1#p1";
const B = "reshumot_scanned:sefer_hachukim_2#p3";
const C = "plenary:K9_9#p9";
const D = "reshumot_scanned:kovetz_hatakanot_4#p4";

describe("line_consensus import", () => {
  it("accepts the fixture", () => {
    expect(lineConsensusImporter.problems(items(), sidecars())).toEqual([]);
  });

  it("queues boxed and no-box lines of volunteer pages only; excluded and maintainer-decided pages give gold or nothing", () => {
    const b = lineConsensusImporter.bundle(items(), sidecars(), { "line_items_v1.json": "x".repeat(64) });
    const real = b.proposals.filter((p) => (p.payload as { gold: unknown }).gold === null).map((p) => p.externalId);
    expect(real).toEqual([`${A}#l0`, `${A}#l1`, `${A}#l2`, `${A}#l3`, `${B}#l0`, `${B}#l1`]);
    const gold = b.proposals.filter((p) => (p.payload as { gold: unknown }).gold !== null);
    expect(gold).toHaveLength(22);
    expect(new Set(gold.map((p) => p.itemExternalId))).toEqual(new Set([C]));
    expect(b.items.map((i) => i.externalId)).not.toContain(D);
    expect(b.proposals.find((p) => p.externalId === `${A}#l3`)!.pageBox).toBeNull(); // no_match: no box, maintainer only
    expect(b.batch.source).toMatchObject({ maintainer_decided_excluded: { exported_at: "2026-11-18T10:00:00.000Z", pages: [D] } });
  });

  it("shows a gold line's planted pre-fill, and keeps the answer out of the content hash", () => {
    const b = lineConsensusImporter.bundle(items(), sidecars());
    const planted = b.proposals.find((p) => p.externalId === `${C}#l2`)!;
    expect((planted.payload as { prefill: string }).prefill).toBe("שורה 3 בעמוד 9");
    expect(JSON.stringify(planted.contentKey)).not.toContain("answer");
  });

  it("refuses gold from a volunteer page, and requires the exclusions, the maintainer record and the hints", () => {
    const gold = read("gold_v1.json") as { lines: Record<string, unknown>[] };
    const bad = { ...gold, lines: [{ ...gold.lines[0]!, page_key: A, image_sha256: (items().pages as { page_key: string; image_sha256: string }[])[0]!.image_sha256 }] };
    expect(lineConsensusImporter.problems(items(), sidecars({ "gold_v1.json": bad })).join("\n")).toMatch(/is a volunteer page/);
    for (const name of ["volunteer_exclusions_v1.json", "maintainer_decided.json", "ai_flags.json"]) {
      const s = sidecars();
      delete (s as Record<string, unknown>)[name];
      expect(lineConsensusImporter.problems(items(), s).join("\n")).toMatch(new RegExp(`${name.replace(".", "\\.")} is required`));
    }
  });

  it("refuses an exclusion naming a page it does not have, and an unregistered manifest", () => {
    const md = { ...read("maintainer_decided.json"), pages: ["plenary:K7_7#p7"] };
    expect(lineConsensusImporter.problems(items(), sidecars({ "maintainer_decided.json": md })).join("\n")).toMatch(/not in line_items_v1\.json/);
    expect(lineConsensusImporter.problems({ ...items(), batch_manifest_sha256: "0".repeat(64) }, sidecars())).toHaveLength(1);
  });

  it("names the series and pads the crop", () => {
    expect(seriesOf("reshumot_scanned:kovetz_hatakanot_311#p6")).toBe("kovetz_hatakanot");
    expect(seriesOf("plenary:K10_125#p10")).toBe("plenary");
    const { pageBox, contextBox } = boxes([100, 1000, 1700, 1060], [1888, 2867]);
    expect(contextBox[1]).toBeLessThan(pageBox[1]);
    expect(contextBox[3]).toBeGreaterThan(pageBox[3]);
    expect(boxes([0, 0, 1888, 40], [1888, 2867]).contextBox).toEqual([0, 0, 1, 0.0307]);
  });
});

describe("line decisions", () => {
  const pre = "סעיף 3 (א)";
  it("an edit equal to the pre-fill is correct; correct, unreadable and not_on_page carry no text", () => {
    expect(normalizeLineDecision(pre, "edit", " סעיף 3 (א) ")).toEqual({ ok: true, value: "correct", text: null });
    expect(normalizeLineDecision(pre, "edit", "סעיף 8 (א)")).toEqual({ ok: true, value: "edit", text: "סעיף 8 (א)" });
    expect(normalizeLineDecision(pre, "correct", "x").ok).toBe(false);
    expect(normalizeLineDecision(pre, "not_on_page", null)).toEqual({ ok: true, value: "not_on_page", text: null });
    expect(normalizeLineDecision(pre, "merge", null).ok).toBe(false);
  });
  it("print has niqqud: the letters only, the pre-fill's when none are typed", () => {
    expect(normalizeLineDecision(pre, "print_has_niqqud", undefined)).toEqual({ ok: true, value: "print_has_niqqud", text: pre });
    expect(normalizeLineDecision(pre, "print_has_niqqud", "סָעִיף").ok).toBe(false);
  });
});

describe("line_consensus_decisions.v0", () => {
  const bundle = lineConsensusImporter.bundle(items(), sidecars(), { "line_items_v1.json": "a".repeat(64), "gold_v1.json": "b".repeat(64) });
  const batch: BatchRecord = { id: bundle.batch.id, taskType: bundle.batch.taskType, title: "", source: bundle.batch.source, minReviewers: 1 };
  const proposals: ProposalRecord[] = bundle.proposals.map((p, k) => ({
    id: k + 1,
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
  const byExt = new Map(proposals.map((p) => [p.externalId, p]));
  let n = 0;
  const dec = (ext: string, reviewer: string, value: string, text: string | null = null): DecisionRecord => {
    const p = byExt.get(ext)!;
    n++;
    return {
      id: `hr-${String(n).padStart(16, "0")}`,
      proposalId: p.id,
      reviewerId: reviewer,
      value,
      text,
      createdAt: `2026-11-18T01:00:${String(n % 60).padStart(2, "0")}.${String(n).padStart(3, "0")}Z`,
      decidedOn: "2026-11-18",
      supersededAt: null,
      proposalSha256: p.contentSha256,
      termsVersion: "2026-11-12-v1",
    };
  };
  // Two volunteers who count (20 of 20 gold), one at 18 of 20 (below the floor).
  const golds = proposals.filter((p) => payloadOf(p).gold).slice(0, 20);
  const goldAnswers = (rv: string, misses: number) =>
    golds.map((g, k) => (k < misses ? dec(g.externalId, rv, "unreadable") : dec(g.externalId, rv, "edit", payloadOf(g).gold!.answer.text ?? "")));
  const [ra, rb, rl, rm] = ["rv_aaaaaaaa", "rv_bbbbbbbb", "rv_11111111", "rv_eeeeeeee"];
  const decisions = [
    ...goldAnswers(ra, 0),
    ...goldAnswers(rb, 0),
    ...goldAnswers(rl, 2),
    dec(`${A}#l0`, ra, "correct"),
    dec(`${A}#l0`, rb, "edit", "שורה 0 בעמוד 1"), // agrees: an edit equal to the pre-fill
    dec(`${A}#l1`, ra, "correct"),
    dec(`${A}#l1`, rl, "correct"), // below the floor: does not count
    dec(`${A}#l3`, rm, "not_on_page"), // the maintainer, on a no-box line
  ];
  const result = buildExport({ batch, proposals, decisions, credits: [], exportedAt: "2026-11-18T12:00:00.000Z", exclusions: [], maintainerDecisions: [decisions[decisions.length - 1]!.id] });
  const file = result.decisionsFile.content as {
    decisions: { page_key: string; i: number; reviewer: string; role: string; counted: boolean; not_counted_reason: string | null; gold_id: string | null; gold_hit: boolean | null; text: string | null }[];
    lines: { page_key: string; i: number; outcome: string; reference: unknown }[];
    reviewers: { reviewer: string; gold_seen: number; gold_hits: number; planted_seen: number; standing: string; decisions_counted: number }[];
    sources: Record<string, string | null>;
  };

  it("validates", () => {
    expect(result.problems).toEqual([]);
    expect(result.decisionsFile.fileName).toBe("line_consensus_decisions.json");
  });
  it("records the inputs' sha256 and agreement.py's", () => {
    expect(file.sources["line_items_v1.json"]).toBe("a".repeat(64));
    expect(file.sources["agreement.py"]).toBe("b0c1bb65397186c57457e2677b06bc92d6696e2af929a436ef408115065d40f7");
  });
  it("gives each line its outcome and reference", () => {
    const line = (i: number) => file.lines.find((l) => l.page_key === A && l.i === i)!;
    expect(line(0)).toMatchObject({ outcome: "agreed", reference: { action: "correct", text: "שורה 0 בעמוד 1" } });
    expect(line(1)).toMatchObject({ outcome: "pending", reference: null });
    expect(line(3)).toMatchObject({ outcome: "maintainer", reference: { action: "not_on_page", text: null } });
  });
  it("marks roles, gold and what counted, with the reason", () => {
    const d = (i: number, rv: string) => file.decisions.find((x) => x.page_key === A && x.i === i && x.reviewer === rv)!;
    expect(d(0, ra)).toMatchObject({ role: "first", counted: true, not_counted_reason: null, text: "שורה 0 בעמוד 1" });
    expect(d(0, rb)).toMatchObject({ role: "second", counted: true });
    expect(d(1, rl)).toMatchObject({ role: "second", counted: false, not_counted_reason: "below_floor" });
    expect(d(3, rm)).toMatchObject({ role: "maintainer", counted: false, not_counted_reason: "maintainer" });
    const g = file.decisions.filter((x) => x.gold_id !== null);
    expect(g).toHaveLength(60);
    expect(g.every((x) => x.role === "gold" && x.counted === false && x.not_counted_reason === "gold_line")).toBe(true);
    expect(g.filter((x) => x.reviewer === rl && x.gold_hit === false)).toHaveLength(2);
  });
  it("reports each volunteer's gold record and standing, not the maintainer", () => {
    expect(file.reviewers.map((r) => r.reviewer)).toEqual([rl, ra, rb]);
    expect(file.reviewers.find((r) => r.reviewer === rl)).toMatchObject({ gold_seen: 20, gold_hits: 18, standing: "below_floor", decisions_counted: 0 });
    expect(file.reviewers.find((r) => r.reviewer === ra)).toMatchObject({ gold_seen: 20, gold_hits: 20, standing: "counting", decisions_counted: 2 });
    expect(file.reviewers.find((r) => r.reviewer === ra)!.planted_seen).toBe(golds.filter((p) => payloadOf(p).gold!.planted_error).length);
  });
});
