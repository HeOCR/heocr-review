import { describe, expect, it } from "vitest";
import { convertH } from "../../scripts/lib/hconvert";
import { contentSha256 } from "../../scripts/lib/importsql";
import { planPrefillSwap, type LiveProposal } from "../../scripts/lib/prefill";
import { lineVerifyImporter } from "../../src/tasks/line_verify/importer";
import { itemsFileProblems } from "../../src/tasks/line_verify/schema";

// The synthetic H fixture's shape (invented ids): three typed lines on two pages, imported as a v1.2 batch.
const box = (y: number) => [100, y, 900, y + 40] as [number, number, number, number];
const v2 = {
  schema: "h_line_items.v2",
  pages: [
    { page_key: "src_a__p0001", image: "a.jpg", image_sha256: "a".repeat(64), image_size: [1000, 1400] as [number, number], segmenter: "blla", stratum: "primary", page_flag: null, lines: [{ id: "v1:0", i: 0, box: box(200) }, { id: "v1:1", i: 1, box: box(300) }] },
    { page_key: "src_b__p0002", image: "b.png", image_sha256: "b".repeat(64), image_size: [1000, 600] as [number, number], segmenter: "blla", stratum: "primary", page_flag: null, lines: [{ id: "v1:0", i: 0, box: box(10) }] },
  ],
};
const row = (entry_id: string) => ({ entry_id, title: "A letter", holding_institution: null, holding_shelfmark: null, provider: "P", source_id: "s", source_url: null, license_expression: "PDM-1.0", rights_basis: "public_domain", attribution: null, sequence: { label: "1" } });
const live12 = convertH(v2, [row("src_a__p0001"), row("src_b__p0002")]) as Record<string, unknown> & { items: Record<string, unknown>[] };
const PROV = `llm:claude-opus-5-5:${"e".repeat(64)}`;
const A0 = "src_a__p0001#v1:0";
const A1 = "src_a__p0001#v1:1";
const B0 = "src_b__p0002#v1:0";

function liveRows(decided: string[] = []): LiveProposal[] {
  return lineVerifyImporter.bundle(live12).proposals.map((p, k) => ({
    id: 100 + k,
    external_id: p.externalId,
    payload_json: JSON.stringify(p.payload),
    content_sha256: contentSha256(p.contentKey),
    decisions: decided.includes(p.externalId) ? 1 : 0,
  }));
}

function v13(drafts: Record<string, string>, change: (items: Record<string, unknown>[]) => void = () => {}) {
  const items = structuredClone(live12.items).map((it) => (drafts[it.item_id as string] !== undefined ? { ...it, candidate_text: drafts[it.item_id as string], candidate_provenance: PROV } : it));
  change(items);
  return { ...structuredClone(live12), schema_version: "line_verify_items.v1.3", items };
}

describe("line_verify_items.v1.3: a typed line's draft", () => {
  it("accepts an unpointed one-line draft with an llm provenance, and nothing else", () => {
    expect(itemsFileProblems(v13({ [A0]: "שורה אחת" }))).toEqual([]);
    expect(itemsFileProblems({ ...v13({ [A0]: "שורה" }), schema_version: "line_verify_items.v1.2" }).join()).toMatch(/must be null on a type item/);
    expect(itemsFileProblems(v13({ [A0]: "שָׁלוֹם" })).join()).toMatch(/without niqqud/);
    expect(itemsFileProblems(v13({ [A0]: "שורה  כפולה" })).join()).toMatch(/repeated whitespace/);
    expect(itemsFileProblems(v13({}, (items) => (items[0]!.candidate_provenance = PROV))).join()).toMatch(/null without a draft/);
    expect(itemsFileProblems(v13({ [A0]: "שורה" }, (items) => (items[0]!.candidate_provenance = "llm:x:abc"))).join()).toMatch(/llm:<model>/);
  });
});

describe("the draft swap plan", () => {
  it("writes drafts only into undecided typed lines, keeping everything else of the live line", () => {
    const plan = planPrefillSwap(v13({ [A0]: "שורה אחת", [A1]: "שורה שנייה" }), "h_eval_v1_lines", liveRows([A1]));
    expect(plan.updates.map((u) => u.item_id)).toEqual([A0]);
    expect(plan.skipped_decided).toEqual([A1]);
    expect(plan.no_draft).toBe(1);
    expect(plan.provenances).toEqual([PROV]);
    const u = plan.updates[0]!;
    const before = JSON.parse(u.old_payload_json);
    expect(JSON.parse(u.payload_json)).toEqual({ ...before, candidate_text: "שורה אחת", candidate_provenance: PROV });
    expect(u.content_sha256).not.toBe(u.old_content_sha256);
  });

  it("re-checks each draft with the app's typed-line rule and skips the ones it rejects", () => {
    const bundle = v13({ [A0]: "שורה", [A1]: "שָׁלוֹם", [B0]: "שורה" }, (items) => (items[2]!.candidate_provenance = "llm:x:abc"));
    const plan = planPrefillSwap(bundle, "h_eval_v1_lines", liveRows());
    expect(plan.updates.map((u) => u.item_id)).toEqual([A0]);
    expect(plan.rejected.map((r) => r.item_id)).toEqual([A1, B0]);
    expect(plan.rejected[0]!.problems.join()).toMatch(/without niqqud/);
  });

  it("refuses a bundle that differs from the live batch beyond the drafts, another batch, or a v1.2 file", () => {
    expect(() => planPrefillSwap(v13({ [B0]: "שורה" }, (items) => ((items[2]!.box as number[])[3] = 55)), "h_eval_v1_lines", liveRows())).toThrow(/differ from the live batch/);
    expect(() => planPrefillSwap(v13({}), "h_eval_v1_lines", liveRows().slice(1))).toThrow(/different lines/);
    expect(() => planPrefillSwap(v13({}), "other_batch", liveRows())).toThrow(/not other_batch/);
    expect(() => planPrefillSwap(live12, "h_eval_v1_lines", liveRows())).toThrow(/must be line_verify_items\.v1\.3/);
  });

  it("re-runs cleanly: a line holding the same draft is left alone, an undecided one with another draft takes the new", () => {
    const first = planPrefillSwap(v13({ [A0]: "שורה", [A1]: "שורה ישנה" }), "h_eval_v1_lines", liveRows());
    const after = liveRows().map((r) => {
      const u = first.updates.find((x) => x.id === r.id);
      return u ? { ...r, payload_json: u.payload_json, content_sha256: u.content_sha256 } : r;
    });
    const again = planPrefillSwap(v13({ [A0]: "שורה", [A1]: "שורה חדשה" }), "h_eval_v1_lines", after);
    expect(again.already).toBe(1);
    expect(again.updates.map((u) => [u.item_id, JSON.parse(u.payload_json).candidate_text])).toEqual([[A1, "שורה חדשה"]]);
  });

  it("is deterministic", () => {
    const a = planPrefillSwap(v13({ [A0]: "שורה" }), "h_eval_v1_lines", liveRows());
    expect(JSON.stringify(a)).toBe(JSON.stringify(planPrefillSwap(v13({ [A0]: "שורה" }), "h_eval_v1_lines", liveRows())));
  });
});
