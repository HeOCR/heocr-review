import { describe, expect, it } from "vitest";
import { appState, BY_WRITER_SQL, oneLine, ph1State, writerTable, type Health } from "../../scripts/ops-health";

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

  it("lists writer codes with sheets uploaded and never an account", () => {
    const table = writerTable([
      { writer: "cw-" + "a".repeat(32), cohort: "kid", total: 8, uploaded: 3, withdrawn: 0 },
      { writer: "cw-" + "b".repeat(32), cohort: "adult", total: 4, uploaded: 4, withdrawn: 1 },
    ], "2026-11-26T05:00:00.000Z");
    expect(table.split("\n").slice(1, 4)).toEqual(["writer\tcohort\tsheets", `cw-${"a".repeat(32)}\tkid\t3 / 8`, `cw-${"b".repeat(32)}\tadult\t4 / 4\twithdrawn`]);
    expect(BY_WRITER_SQL).not.toMatch(/writer_account|guardian_account|reviewers|email/);
  });
});
