import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSubsetStatements, interimMembers, interimProblems } from "../../scripts/lib/subset";
import { servedMembers, takesOut, type CurrentDecisionRow, type SubsetMemberRow } from "../../src/worker/subsets";

const fixture = JSON.parse(readFileSync("test/fixtures/page_review/interim_fixture.json", "utf8")) as Record<string, any>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("interim set file", () => {
  it("accepts the fixture and lists each stratum's pick, then its alternates", () => {
    expect(interimProblems(fixture)).toEqual([]);
    expect(interimMembers(fixture)).toEqual([
      { stratum: "sefer_hachukim|1948-59", position: 0, externalId: "reshumot_scanned:sefer_hachukim_1#p2" },
      { stratum: "sefer_hachukim|1948-59", position: 1, externalId: "reshumot_scanned:kovetz_hatakanot_7#p1" },
      { stratum: "plenary|1949-59", position: 0, externalId: "plenary:K2_1#p3" },
    ]);
  });

  it.each([
    ["another schema", (f: any) => (f.schema = "x"), "schema must be"],
    ["a stratum twice", (f: any) => (f.pages[1].stratum = f.pages[0].stratum), "listed twice"],
    ["a page twice", (f: any) => f.pages[1].alternates.push(f.pages[0].key), "listed twice"],
    ["no alternates list", (f: any) => delete f.pages[0].alternates, "must have key, stratum and alternates"],
  ])("refuses %s", (_name, mutate, needle) => {
    const f = clone(fixture);
    mutate(f);
    expect(interimProblems(f).join("\n")).toContain(needle);
  });

  it("writes only the subset tables", () => {
    const sql = buildSubsetStatements("b1", { id: "interim_v1", title: "סט", sourceSha256: "ab" }, interimMembers(fixture), "2026-11-15T00:00:00.000Z");
    expect(sql).toHaveLength(2 + 3);
    for (const s of sql) expect(s).toMatch(/^(INSERT INTO subsets |DELETE FROM subset_members |INSERT INTO subset_members )/);
  });
});

describe("servedMembers", () => {
  const m = (stratum: string, position: number, proposal_id: number | null, active = 1): SubsetMemberRow => ({ stratum, position, proposal_id, active });
  const members = [m("a", 0, 10), m("a", 1, 11), m("a", 2, 12), m("b", 0, 20)];
  const d = (proposal_id: number, value: string, lines?: string[]): CurrentDecisionRow => ({
    proposal_id,
    value,
    text: lines ? JSON.stringify({ page_action: value, lines: lines.map((action, i) => ({ i_src: [i], action, text: null })) }) : null,
  });

  it("serves each stratum's pick while it stands", () => {
    expect(servedMembers(members, [])).toEqual({ ids: [10, 20], strata: 2 });
    expect(servedMembers(members, [d(10, "confirm", ["correct", "not_on_page"])]).ids).toEqual([10, 20]);
  });

  it("replaces a rejected pick, or one confirmed with no reference line, by the next alternate still standing", () => {
    expect(servedMembers(members, [d(10, "reject")]).ids).toEqual([11, 20]);
    expect(servedMembers(members, [d(10, "confirm", ["not_on_page", "unreadable"])]).ids).toEqual([11, 20]);
    expect(servedMembers(members, [d(10, "reject"), d(11, "reject")]).ids).toEqual([12, 20]);
    expect(servedMembers([m("a", 0, 10, 0), m("a", 1, 11)], []).ids).toEqual([11]); // an inactive pick
    expect(servedMembers([m("a", 0, null), m("a", 1, 11)], []).ids).toEqual([11]); // not in the batch
  });

  it("serves nothing for a stratum whose members are all out, and still counts it", () => {
    expect(servedMembers(members, [d(10, "reject"), d(11, "reject"), d(12, "reject")])).toEqual({ ids: [20], strata: 2 });
  });

  it("only a rejection or an empty confirm takes a page out", () => {
    expect(takesOut({ value: "reject", text: null })).toBe(true);
    expect(takesOut({ value: "confirm", text: JSON.stringify({ lines: [] }) })).toBe(true);
    expect(takesOut({ value: "confirm", text: JSON.stringify({ lines: [{ action: "edit" }] }) })).toBe(false);
    expect(takesOut({ value: "accepted", text: null })).toBe(false); // other task types
    expect(takesOut({ value: "confirm", text: "not json" })).toBe(false);
  });
});
