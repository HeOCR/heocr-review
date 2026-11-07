/**
 * Run exported decisions through hocrgen's own validator (`python -m hocrgen.tools.reference_audit`).
 *
 * Needs a hocrgen checkout (HOCRGEN_DIR, default ~/clones/hocrgen; only its src/ is used, no install) and python3.
 * CI checks out HeOCR/hocrgen and sets HOCRGEN_REQUIRED=1, so the test cannot be skipped there.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentSha256 } from "../../scripts/lib/importsql";
import { buildExport, formatJson } from "../../src/tasks/export";
import { referenceAuditImporter } from "../../src/tasks/reference_audit/importer";
import type { DecisionRecord, ProposalRecord } from "../../src/tasks/types";

const HOCRGEN = process.env.HOCRGEN_DIR ?? join(homedir(), "clones", "hocrgen");
const PYTHON = process.env.HOCRGEN_PYTHON ?? "python3";
const tool = join(HOCRGEN, "src", "hocrgen", "tools", "reference_audit.py");
const available = existsSync(tool) && spawnSync(PYTHON, ["--version"]).status === 0;
const committed = join(HOCRGEN, "docs", "reference_audit_proposals.json");

if (process.env.HOCRGEN_REQUIRED === "1" && !available) throw new Error(`hocrgen validator not found at ${tool}`);

function hocrgenValidate(proposalsPath: string, decisions: unknown, minReviewers = 1): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "heocr-review-"));
  const decisionsPath = join(dir, "reference_audit_decisions.json");
  writeFileSync(decisionsPath, formatJson(decisions));
  const res = spawnSync(
    PYTHON,
    ["-m", "hocrgen.tools.reference_audit", "--proposals", proposalsPath, "--decisions", decisionsPath, "--min-reviewers", String(minReviewers)],
    { env: { ...process.env, PYTHONPATH: join(HOCRGEN, "src") }, encoding: "utf8" },
  );
  return { status: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** Records as the Worker would hold them after importing `path`, plus decisions by several reviewers. */
function exportFor(path: string, minReviewers: number) {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const bundle = referenceAuditImporter.bundle(raw);
  const proposals: ProposalRecord[] = bundle.proposals.map((p, i) => ({
    id: i + 1,
    batchId: bundle.batch.id,
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
  const values = ["accepted", "rejected", "edited"] as const;
  let n = 0;
  const d = (p: ProposalRecord, reviewerId: string, value: string, extra: Partial<DecisionRecord> = {}): DecisionRecord => ({
    id: `hr-${(n++).toString(16).padStart(16, "0")}`,
    proposalId: p.id,
    reviewerId,
    value,
    text: value === "edited" ? `${String(p.payload.proposed)}א` : null,
    createdAt: `2026-11-07T10:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`,
    decidedOn: "2026-11-07",
    supersededAt: null,
    proposalSha256: p.contentSha256,
    termsVersion: "t",
    ...extra,
  });
  const decisions: DecisionRecord[] = [];
  proposals.forEach((p, i) => {
    decisions.push(d(p, "rv_0a1b2c3d", values[i % 3]!));
    if (i % 4 === 0) decisions.push(d(p, "rv_9f8e7d6c", "rejected")); // second reviewer: agree or conflict
    if (i % 5 === 0) decisions.push(d(p, "rv_0a1b2c3d", "accepted", { supersededAt: "2026-11-07T09:00:00.000Z" })); // history
    if (i % 6 === 0) decisions.push(d(p, "rv_55555555", "accepted", { proposalSha256: "f".repeat(64) })); // stale
  });
  return buildExport({
    batch: { id: bundle.batch.id, taskType: "reference_audit", title: "", source: bundle.batch.source, minReviewers },
    proposals,
    decisions,
    credits: [],
    exportedAt: "2026-11-07T12:00:00.000Z",
  });
}

describe.runIf(available)("hocrgen's validator accepts the export", () => {
  it("on the fixture, with several reviewers, conflicts, superseded and stale decisions", () => {
    const fixture = "test/fixtures/proposals.fixture.json";
    for (const min of [1, 2]) {
      const r = exportFor(fixture, min);
      expect(r.problems).toEqual([]);
      const res = hocrgenValidate(fixture, r.decisionsFile.content, min);
      expect(res.out).not.toMatch(/Error|not a valid/);
      expect(res.status).toBe(0);
      const summary = JSON.parse(res.out.slice(res.out.indexOf("{"))) as { reviewers: number; undecided_proposals: number };
      expect(summary.reviewers).toBe(2);
      expect(summary.undecided_proposals).toBe(0);
    }
  });

  it.runIf(existsSync(committed))("on hocrgen's committed 519 E2d4 proposals", () => {
    const r = exportFor(committed, 1);
    expect(r.problems).toEqual([]);
    const res = hocrgenValidate(committed, r.decisionsFile.content);
    expect(res.status, res.out.slice(-2000)).toBe(0);
    const summary = JSON.parse(res.out.slice(res.out.indexOf("{"))) as { proposals: number; undecided_proposals: number };
    expect(summary.proposals).toBe(519);
    expect(summary.undecided_proposals).toBe(0);
  });

  it("and its validator would refuse a bad reviewer id (the test can fail)", () => {
    const r = exportFor("test/fixtures/proposals.fixture.json", 1);
    const bad = r.decisionsFile.content as { decisions: { reviewer: string }[] };
    bad.decisions[0]!.reviewer = "rv-0a1b2c3d";
    expect(hocrgenValidate("test/fixtures/proposals.fixture.json", bad).status).not.toBe(0);
  });
});
