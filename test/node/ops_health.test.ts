import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { appState, BY_WRITER_SQL, oneLine, paymentRows, paymentTable, ph1State, type Health } from "../../scripts/ops-health";
import { PAYMENT_ALPHABET, paymentCodeFromMac, paymentMessage } from "../../src/shared/payment-code";

const health: Health = {
  at: "2026-11-26T05:00:00.000Z",
  target: "production",
  contributor_app: "on",
  ph1: "on",
  ph1_photos: 12,
  ph1_recompressed: 1,
  handwriting: { contributor_enrolments: 0, contributor_submissions: 0, contributor_handwriting_roster: 0 },
  triage: [{ batch: "b1", status: "open", lines: 10, answered: 4, to_desktop: 2, plants: 1 }],
  decisions: 1000,
  d1_rows_written_today: 1234,
};

describe("ops health", () => {
  it("reads the signed-out probes", () => {
    expect([appState(401), appState(404), appState(500)]).toEqual(["on", "off", "unknown"]);
    expect([ph1State(200), ph1State(404), ph1State(403), ph1State(0)]).toEqual(["on", "off", "off", "unknown"]);
  });

  it("gives one line of counts only", () => {
    expect(oneLine(health)).toBe(
      "2026-11-26T05:00Z production | contributor on | hw enrol 0 / sub 0 / roster 0 | PH1 ON 12/420 photos (1 recompressed) | triage: b1 4/10 (desk 2) | decisions 1000 | D1 writes today 1234",
    );
    expect(oneLine({ ...health, ph1: "off", triage: [] })).toContain("PH1 OFF | triage: none");
  });

  it("prints payment codes only, sorted by code, and fails loudly on a collision", () => {
    const rows = [
      { writer: "cw-" + "a".repeat(32), cohort: "kid" as const, total: 8, uploaded: 3, withdrawn: 0 },
      { writer: "cw-" + "b".repeat(32), cohort: "adult" as const, total: 4, uploaded: 4, withdrawn: 1 },
    ];
    const out = paymentRows(rows, "fixture-secret");
    const code = (w: string) => paymentCodeFromMac(createHmac("sha256", "fixture-secret").update(paymentMessage(w)).digest());
    expect(out.map((r) => r.code).sort()).toEqual([code(rows[0]!.writer), code(rows[1]!.writer)].sort());
    for (const r of out) expect(r.code).toMatch(new RegExp(`^[${PAYMENT_ALPHABET}]{6}$`));
    expect(PAYMENT_ALPHABET).not.toMatch(/[01OIL]/);
    expect(PAYMENT_ALPHABET).toHaveLength(31);
    const table = paymentTable(out, "2026-11-26T05:00:00.000Z");
    expect(table).not.toContain("cw-");
    expect(table).toContain(`${code(rows[0]!.writer)}\tkid\t3 / 8`);
    expect(table).toContain(`${code(rows[1]!.writer)}\tadult\t4 / 4\twithdrawn`);
    expect(() => paymentRows([rows[0]!, rows[0]!], "fixture-secret")).toThrow(/collision/);
    expect(BY_WRITER_SQL).not.toMatch(/writer_account|guardian_account|reviewers|email|kids_slot AS|set_id|split/);
  });
});
