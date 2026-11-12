import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/shared/sha256";
import { buildExport } from "../../src/tasks/export";
import { pageReview, payloadOf } from "../../src/tasks/page_review";
import { pageReviewImporter } from "../../src/tasks/page_review/importer";
import { manifestProblems, normalizePageDecision, prefillLines, splitLines, type PrefillLine } from "../../src/tasks/page_review/schema";
import type { BatchRecord, DecisionRecord, ProposalRecord } from "../../src/tasks/types";
import { assignReserves } from "../../src/worker/reserves";

const DIR = "test/fixtures/page_review";
const manifest = JSON.parse(readFileSync(`${DIR}/batch_manifest.json`, "utf8")) as Record<string, any>;
const blind = JSON.parse(readFileSync(`${DIR}/blind_prefill.json`, "utf8")) as Record<string, any>;
const sidecars = { "blind_prefill.json": blind };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const shown: PrefillLine[] = [
  { i: 0, text: "שורה ראשונה 1953", tier_a: true, bidi_risk: true, match: 100 },
  { i: 2, text: "שורה שנייה", tier_a: false, bidi_risk: false, match: 99 },
  { i: 3, text: "שורה שלישית וארוכה", tier_a: false, bidi_risk: false, match: 99 },
];
const ok = (lines: unknown[], ro: boolean | null = null) => ({ lines, reading_order_verified: ro });
const L = (src: number[], action: string, text?: string | null) => ({ src, action, ...(text === undefined ? {} : { text }) });

describe("splitLines and prefillLines", () => {
  it("splits like Python's str.splitlines()", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(splitLines("a\r\nb\fc")).toEqual(["a", "b", "c"]);
  });

  it("shows every non-blank line; a line without flags is tier A when it has a digit or bracket", () => {
    const p = manifest.pages[0];
    const lines = prefillLines(p.prefill, p.lines);
    expect(lines.map((l) => [l.i, l.tier_a, l.match])).toEqual([
      [0, true, 100],
      [2, true, 70],
      [3, true, null], // "649": no flags entry, has digits
      [4, false, 99],
    ]);
    expect(prefillLines("שלום\n(א)\n.\n", []).map((l) => [l.i, l.tier_a])).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
  });
});

describe("heocr_midcentury_batch.v0 import", () => {
  it("accepts the fixture with its blind pre-fill", () => {
    expect(manifestProblems(manifest, blind)).toEqual([]);
    expect(pageReviewImporter.problems(manifest, sidecars)).toEqual([]);
  });

  it.each([
    ["another schema", (m: any) => (m.schema_version = "x"), "schema_version"],
    ["a page twice", (m: any) => m.pages.push(clone(m.pages[0])), "listed twice"],
    ["a flags entry on a blank line", (m: any) => (m.pages[0].lines[1].i = 1), "blank line"],
    ["a blind reserve", (m: any) => (m.pages[3].blind_second_pass = true), "only a test page"],
    ["a bad role", (m: any) => (m.pages[0].role = "spare"), "role"],
  ])("refuses %s", (_name, mutate, needle) => {
    const m = clone(manifest);
    mutate(m);
    expect(manifestProblems(m).join("\n")).toContain(needle);
  });

  it("refuses a blind pre-fill for a page the manifest does not mark blind, or one missing", () => {
    const b = clone(blind);
    b.pages[0].unit_id = "plenary:K2_1";
    b.pages[0].page = 3;
    const problems = manifestProblems(manifest, b).join("\n");
    expect(problems).toContain("does not mark it blind_second_pass");
    expect(problems).toContain("no blind pre-fill");
  });

  it("queues test pages, then reserves, then the blind second pass, with their gates", () => {
    const bundle = pageReviewImporter.bundle(manifest, sidecars);
    expect(bundle.batch.id).toBe("newprinted_midcentury_v0");
    expect(bundle.items).toHaveLength(5);
    expect(bundle.items[0]!.bundleImage).toEqual({ path: "pages/reshumot_scanned_sefer_hachukim_1_p0002.png", sha256: manifest.pages[0].image_sha256 });
    expect(bundle.proposals.map((p) => [p.externalId, p.rank, p.confidence, p.gate ?? null])).toEqual([
      ["reshumot_scanned:sefer_hachukim_1#p2", 0, "test", null],
      ["plenary:K2_1#p3", 1, "test", null],
      ["reshumot_scanned:kovetz_hatakanot_7#p1", 2, "test", null],
      ["plenary:K2_9#p5", 3, "reserve", { kind: "reserve", ref: null }],
      ["reshumot_scanned:kovetz_hatakanot_8#p4", 4, "reserve", { kind: "reserve", ref: null }],
      ["reshumot_scanned:sefer_hachukim_1#p2@pass2", 5, "blind_second_pass", { kind: "after_confirm", ref: "reshumot_scanned:sefer_hachukim_1#p2" }],
    ]);
    const pass2 = bundle.proposals[5]!.payload as any;
    expect(pass2.pass).toBe(2);
    expect(pass2.prefill_source).toBe("stock_tesseract heb psm4");
    expect(pass2.prefill_sha256).toBe(sha256Hex(blind.pages[0].blind_prefill));
    // The blind pre-fill has no flags of its own: the digit-or-bracket rule marks its lines.
    expect(pass2.lines.map((l: PrefillLine) => [l.i, l.tier_a, l.match])).toEqual([
      [0, true, null],
      [1, true, null],
      [2, false, null],
    ]);
    expect((bundle.proposals[0]!.payload as any).prefill_sha256).toBe(sha256Hex(manifest.pages[0].prefill));
  });

  it("leaves the blind pass out without the sidecar", () => {
    expect(pageReviewImporter.bundle(manifest, {}).proposals).toHaveLength(5);
  });
});

describe("normalizePageDecision", () => {
  it("confirms the pre-fill as it is, filling in each correct line's text", () => {
    const n = normalizePageDecision(shown, false, "confirm", ok([L([0], "correct"), L([2], "correct", null), L([3], "correct", "שורה שלישית וארוכה")]));
    expect(n).toEqual({
      ok: true,
      decision: {
        page_action: "confirm",
        reading_order_verified: null,
        lines: [
          { i_src: [0], action: "correct", text: "שורה ראשונה 1953" },
          { i_src: [2], action: "correct", text: "שורה שנייה" },
          { i_src: [3], action: "correct", text: "שורה שלישית וארוכה" },
        ],
      },
    });
  });

  it("records edits, merges, splits, added lines, exclusions and a moved line", () => {
    const n = normalizePageDecision(
      shown,
      false,
      "confirm",
      ok([
        L([3], "split", "שורה שלישית"),
        L([3], "split", "וארוכה"),
        L([], "added", "הערת שוליים"),
        L([0, 2], "merge", "שורה ראשונה 1953 שורה שנייה"),
      ]),
    );
    expect(n.ok).toBe(true);
    if (n.ok && n.decision.page_action === "confirm") expect(n.decision.lines.map((l) => l.action)).toEqual(["split", "split", "added", "merge"]);
    const m = normalizePageDecision(shown, false, "confirm", ok([L([0], "edit", " שורה ראשונה 1953 "), L([2], "not_on_page"), L([3], "unreadable")]));
    expect(m.ok && m.decision.page_action === "confirm" && m.decision.lines.map((l) => [l.action, l.text])).toEqual([
      ["correct", "שורה ראשונה 1953"], // an edit equal to the pre-fill is correct
      ["not_on_page", null],
      ["unreadable", null],
    ]);
  });

  it.each([
    ["a line left out", ok([L([0], "correct"), L([2], "correct")]), "not covered"],
    ["a line twice", ok([L([0], "correct"), L([0], "edit", "x"), L([2], "correct"), L([3], "correct")]), "covered twice"],
    ["split pieces apart", ok([L([3], "split", "a"), L([0], "correct"), L([3], "split", "b"), L([2], "correct")]), "covered twice"],
    ["a lone split piece", ok([L([3], "split", "a"), L([0], "correct"), L([2], "correct")]), "two or more lines"],
    ["a merge of one line", ok([L([0], "merge", "x"), L([2], "correct"), L([3], "correct")]), "two or more"],
    ["an added line with a source", ok([L([0], "added", "x"), L([2], "correct"), L([3], "correct")]), "no source line"],
    ["an unknown line", ok([L([1], "correct"), L([0], "correct"), L([2], "correct"), L([3], "correct")]), "not on this page"],
    ["text on an excluded line", ok([L([0], "unreadable", "x"), L([2], "correct"), L([3], "correct")]), "has no text"],
    ["an edit without text", ok([L([0], "edit"), L([2], "correct"), L([3], "correct")]), "type the line"],
    ["a correct line with other text", ok([L([0], "correct", "אחר"), L([2], "correct"), L([3], "correct")]), "keeps the pre-fill"],
    ["niqqud typed on a niqqud line", ok([L([0], "print_has_niqqud", "שָׁלוֹם"), L([2], "correct"), L([3], "correct")]), "without niqqud"],
    ["a line break in a line", ok([L([0], "edit", "א\nב"), L([2], "correct"), L([3], "correct")]), "one line"],
  ])("refuses %s", (_name, input, needle) => {
    const n = normalizePageDecision(shown, false, "confirm", input);
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.error).toContain(needle);
  });

  it("needs the reading order confirmed on a page that asks for it, and refuses it elsewhere", () => {
    const lines = [L([0], "correct"), L([2], "correct"), L([3], "correct")];
    expect(normalizePageDecision(shown, true, "confirm", ok(lines)).ok).toBe(false);
    const n = normalizePageDecision(shown, true, "confirm", ok(lines, true));
    expect(n.ok && n.decision.page_action === "confirm" && n.decision.reading_order_verified).toBe(true);
    expect(normalizePageDecision(shown, false, "confirm", ok(lines, true)).ok).toBe(false);
  });

  it("rejects a page with a reason from the list; other needs a note", () => {
    expect(normalizePageDecision(shown, false, "reject", { reject_reason: "blank" })).toEqual({
      ok: true,
      decision: { page_action: "reject", reject_reason: "blank", reject_note: null },
    });
    expect(normalizePageDecision(shown, false, "reject", { reject_reason: "other" }).ok).toBe(false);
    expect(normalizePageDecision(shown, false, "reject", { reject_reason: "other", reject_note: " cut at the top " })).toMatchObject({
      ok: true,
      decision: { reject_note: "cut at the top" },
    });
    expect(normalizePageDecision(shown, false, "reject", { reject_reason: "torn" }).ok).toBe(false);
    expect(normalizePageDecision(shown, false, "maybe", {}).ok).toBe(false);
  });
});

describe("assignReserves", () => {
  const r = (id: number, category: string, gate: string | null, rejected = 0) => ({ id, category, gate_kind: gate, rejected });

  it("opens no reserve until a page is rejected, then the same category's first, else the next in order", () => {
    const rows = [r(1, "a", null), r(2, "b", null), r(3, "c", null), r(10, "x", "reserve"), r(11, "b", "reserve"), r(12, "b", "reserve")];
    expect(assignReserves(rows)).toEqual([]);
    rows[1]!.rejected = 1;
    expect(assignReserves(rows)).toEqual([11]);
    rows[0]!.rejected = 1;
    expect(assignReserves(rows).sort()).toEqual([10, 11]);
  });

  it("replaces a rejected reserve too, and stops when none are left", () => {
    const rows = [r(1, "a", null, 1), r(10, "a", "reserve", 1), r(11, "a", "reserve", 1)];
    expect(assignReserves(rows)).toEqual([10, 11]);
  });
});

describe("page_review_decisions.v0 export", () => {
  const bundle = pageReviewImporter.bundle(manifest, sidecars);
  const proposals: ProposalRecord[] = bundle.proposals.map((p, k) => ({
    id: k + 1,
    batchId: bundle.batch.id,
    externalId: p.externalId,
    itemExternalId: p.itemExternalId,
    itemTitle: p.itemExternalId,
    category: p.category,
    confidence: p.confidence,
    rank: p.rank,
    payload: p.payload,
    media: {},
    contentSha256: `sha${k}`,
    active: true,
  }));
  const batch: BatchRecord = { id: bundle.batch.id, taskType: "page_review", title: "t", source: bundle.batch.source, minReviewers: 1 };
  const decide = (p: ProposalRecord, value: string, input: unknown, at: string, superseded: string | null = null): DecisionRecord => {
    const n = pageReview.normalizeDecision(p, value, JSON.stringify(input));
    if (!n.ok) throw new Error(n.error);
    return {
      id: `hr-${p.id}-${at}`,
      proposalId: p.id,
      reviewerId: "rv_0123abcd",
      value: n.value,
      text: n.text,
      createdAt: at,
      decidedOn: at.slice(0, 10),
      supersededAt: superseded,
      proposalSha256: p.contentSha256,
      termsVersion: "t1",
    };
  };
  const linesOf = (p: ProposalRecord) => payloadOf(p).lines.map((l) => L([l.i], "correct"));

  it("exports one valid record per page and reviewer, with first_decided_at and the pass", () => {
    const [p1, p2, , , , pass2] = proposals as [ProposalRecord, ProposalRecord, ProposalRecord, ProposalRecord, ProposalRecord, ProposalRecord];
    const decisions = [
      decide(p1, "reject", { reject_reason: "blank" }, "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z"),
      decide(p1, "confirm", ok([L([0], "edit", "חוק הדגמה, תשי\"ג–1953"), ...linesOf(p1).slice(1)]), "2026-11-12T09:00:00.000Z"),
      decide(p2, "confirm", ok([L([1], "print_has_niqqud", "חבר הכנסת: תודה רבה לכם"), L([0], "correct")], true), "2026-11-12T09:05:00.000Z"),
      decide(pass2, "confirm", ok(linesOf(pass2)), "2026-11-13T10:00:00.000Z"),
    ];
    const out = buildExport({ batch, proposals, decisions, credits: [], exportedAt: "2026-11-13T11:00:00.000Z" });
    expect(out.problems).toEqual([]);
    const file = out.decisionsFile.content as any;
    expect(out.decisionsFile.fileName).toBe("page_review_decisions.json");
    expect(file.schema_version).toBe("page_review_decisions.v0");
    expect(file.decisions.map((d: any) => [d.decision_id, d.pass, d.blind_second_pass, d.page_action])).toEqual([
      ["decision:reshumot_scanned:sefer_hachukim_1#p2:rv_0123abcd", 1, true, "confirm"],
      ["decision:plenary:K2_1#p3:rv_0123abcd", 1, false, "confirm"],
      ["decision:reshumot_scanned:sefer_hachukim_1#p2@pass2:rv_0123abcd", 2, true, "confirm"],
    ]);
    const first = file.decisions[0];
    expect(first.first_decided_at).toBe("2026-11-12T08:00:00.000Z");
    expect(first.decided_at).toBe("2026-11-12T09:00:00.000Z");
    expect(first.counts).toEqual({ tier_a: 3, edited: 1, excluded: 0 });
    expect(first.lines[0]).toEqual({ i_src: [0], action: "edit", text: "חוק הדגמה, תשי\"ג–1953", reference_views: ["primary", "consonantal"] });
    const second = file.decisions[1];
    expect(second.reading_order_verified).toBe(true);
    expect(second.lines[0].reference_views).toEqual(["consonantal"]);
    expect(file.decisions[2].prefill_sha256).toBe(sha256Hex(blind.pages[0].blind_prefill));
  });

  it("finds a tampered record", () => {
    const p1 = proposals[0]!;
    const out = buildExport({ batch, proposals, decisions: [decide(p1, "confirm", ok(linesOf(p1)), "2026-11-12T09:00:00.000Z")], credits: [], exportedAt: "x" });
    const file = clone(out.decisionsFile.content) as any;
    file.decisions[0].lines.pop();
    file.decisions[0].pass = 2;
    const problems = pageReview.validateExport(batch, proposals, file).join("\n");
    expect(problems).toContain("pass must be 1");
    expect(problems).toContain("not covered");
  });
});
