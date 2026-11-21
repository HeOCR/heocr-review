import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import type { ImportBundle } from "../../src/tasks/import";
import { commaReadbackSql, guardedCommaUpdate, planCommaBackfill, type CommaDraftRow } from "../../scripts/lib/draft-comma-backfill";
import { COMMA_AUDIT, PUNCTUATION_AUDIT, commaSpacingRevision, normalizeDraftPunctuation, originalDraftContent,
  punctuationSpacingRevision, punctuationSwitches, type PunctuationMark } from "../../scripts/lib/draft-comma-spacing";
import { buildImportSql } from "../../scripts/lib/importsql";

const marks: readonly PunctuationMark[] = [".", ";", ":", "?", "!"];

it.each([
  ["המדד 3 .5 נקודות", "decimal"],
  ["התאריך 21 .11 נקבע", "date"],
  ["השעון 12 :30 מצלצל", "time"],
  ['כתוב :"7 פריטים"', "colon before a quoted number"],
  ["שאלו Hello ?World", "Latin run"],
  ["ענתה Hello !שלום", "mixed-script boundary"],
  ["נראה ...אולי", "ellipsis"],
  ["פגשנו ד״ר .לוין", "Hebrew abbreviation"],
  ["רשימה :(ב) מגבת", "Hebrew enumerator"],
  ["מצרכים :לחם, גבינה", "inline Hebrew list"],
  ["פגשנו פרופ .כהן", "known unmarked Hebrew abbreviation"],
  ["רשימה :י״א. מגבת", "Hebrew number with gershayim"],
  ["שקט . . .ממשיכים", "spaced ellipsis"],
] as const)("leaves %s intact (%s)", (text, reason) => {
  expect(normalizeDraftPunctuation(text, marks), reason).toBe(text);
});

it("requires explicit per-mark switches and applies only the enabled marks", () => {
  const text = "המדפסת .התקלקלה ;הטכנאי שאל ?מחר";
  expect(punctuationSwitches({})).toEqual([]);
  expect(punctuationSwitches({ semicolon: true, "exclamation-mark": true })).toEqual([";", "!"]);
  expect(() => punctuationSwitches({ period: "false" })).toThrow("--period does not take a value");
  expect(normalizeDraftPunctuation(text)).toBe(text);
  expect(normalizeDraftPunctuation(text, [";"])).toBe("המדפסת .התקלקלה; הטכנאי שאל ?מחר");
  expect(normalizeDraftPunctuation("ההסבר :מופיעה שורה !זהירות .", [":", "!", "."])).toBe("ההסבר: מופיעה שורה! זהירות.");
  expect(normalizeDraftPunctuation("המכתב .\nהודעה !", [".", "!"])).toBe("המכתב.\nהודעה!");
  expect(normalizeDraftPunctuation("המדד . שונה", ["."])).toBe("המדד . שונה");
});

it("adds opt-in revisions after the existing comma audit and can recover each preceding revision", () => {
  const fields = { candidate_text: "מכתב ,הגיע !זהירות .", attention_spans: [[0, 4]] };
  const comma = commaSpacingRevision("line_verify", fields, "original")!;
  const period = punctuationSpacingRevision("line_verify", comma.payload, comma.contentSha256, ["."])!;
  const bang = punctuationSpacingRevision("line_verify", period.payload, period.contentSha256, ["!"])!;
  const [first, second] = bang.payload[PUNCTUATION_AUDIT];
  expect(bang.payload.candidate_text).toBe("מכתב, הגיע! זהירות.");
  expect(bang.payload[COMMA_AUDIT]).toEqual(comma.payload[COMMA_AUDIT]);
  expect(first?.content_sha256).toBe(comma.contentSha256);
  expect(second?.content_sha256).toBe(period.contentSha256);
  expect(second?.fields.candidate_text).toBe("מכתב, הגיע !זהירות.");
  expect(originalDraftContent(bang.payload, bang.contentSha256)).toEqual({ content_sha256: "original", fields });
  expect(punctuationSpacingRevision("line_verify", bang.payload, bang.contentSha256, marks)).toBeNull();

  const beforeComma = punctuationSpacingRevision("line_verify", fields, "original", ["."])!;
  const afterComma = commaSpacingRevision("line_verify", beforeComma.payload, beforeComma.contentSha256)!;
  expect(originalDraftContent(afterComma.payload, afterComma.contentSha256)).toEqual({ content_sha256: "original", fields });
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync("migrations/" + file, "utf8"));
  return db;
}

it("keeps comma fixes on by default for imports and preserves a prior opt-in when re-imported", () => {
  const db = fixture();
  try {
    const candidate = "מכתב ,הגיע !זהירות";
    const bundle: ImportBundle = {
      batch: { id: "fixture", taskType: "line_verify", title: "Fixture", source: {} },
      items: [{ externalId: "page", title: "Fixture", payload: {}, imageStem: null }],
      proposals: [{
        externalId: "draft", itemExternalId: "page", category: "a", confidence: "a", rank: 0,
        payload: { candidate_text: candidate }, pageBox: null, contentKey: { candidate },
      }],
    };
    const opts = { minReviewers: 1, importedAt: "now" };
    const text = () => db.prepare("SELECT json_extract(payload_json,'$.candidate_text') AS text FROM proposals").get()?.text;
    db.exec(buildImportSql(bundle, new Map(), opts));
    expect(text()).toBe("מכתב, הגיע !זהירות");
    db.exec(buildImportSql(bundle, new Map(), { ...opts, punctuation: ["!"] }));
    expect(text()).toBe("מכתב, הגיע! זהירות");
    db.exec(buildImportSql(bundle, new Map(), opts));
    expect(text()).toBe("מכתב, הגיע! זהירות");
  } finally {
    db.close();
  }
});

it("counts per-mark changes without editing other marks, histories, plants or assignments", () => {
  const db = fixture();
  try {
    db.exec(`INSERT INTO batches(id,task_type,title,source_json,status,imported_at) VALUES ('demo','line_verify','Fixture','{}','open','now');
      INSERT INTO items(id,batch_id,external_id,title,payload_json) VALUES (1,'demo','page','Fixture','{}');
      INSERT INTO proposals(id,batch_id,item_id,external_id,category,confidence,rank,payload_json,media_json,content_sha256)
        VALUES (1,'demo',1,'line','a','a',0,'{"candidate_text":"נפתח !זהירות ;חכו"}','{}','sha1');`);
    const row = db.prepare("SELECT * FROM proposals").get() as unknown as CommaDraftRow;
    const rows = [
      { ...row, task_type: "line_verify", queue: "review", reviewed: 0, served: 0, planted: 0 },
      { ...row, id: 2, task_type: "line_verify", queue: "review", reviewed: 1, served: 0, planted: 0 },
      { ...row, id: 3, task_type: "line_verify", queue: "review", reviewed: 0, served: 1, planted: 0 },
      { ...row, id: 4, task_type: "line_verify", queue: "review", reviewed: 0, served: 0, planted: 1 },
    ];
    expect(planCommaBackfill(rows).updates).toHaveLength(0);
    const plan = planCommaBackfill(rows, ["!"]);
    expect(plan.queues["demo/review"]).toMatchObject({ changes: 1, changed_lines: 1, reviewed: 1, already_served: 1, registered_plant: 1 });
    db.exec(guardedCommaUpdate(plan.updates[0]!));
    expect(db.prepare("SELECT json_extract(payload_json,'$.candidate_text') text FROM proposals").get()?.text).toBe("נפתח! זהירות ;חכו");
    expect(db.prepare(commaReadbackSql([1], true)).get()?.original_sha).toBe("sha1");
  } finally {
    db.close();
  }
});
