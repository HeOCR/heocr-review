import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { ImportBundle } from "../../src/tasks/import";
import { buildImportSql } from "../../scripts/lib/importsql";
import { commaDraftsSql, guardedCommaUpdate, planCommaBackfill, type CommaDraftRow } from "../../scripts/lib/draft-comma-backfill";
import { commaSpacingRevision, normalizeDraftCommas } from "../../scripts/lib/draft-comma-spacing";
import { readdirSync, readFileSync } from "node:fs";

it("fixes only the approved patterns in adjacent Hebrew context", () => {
  const s = "מכתב (חדש) ,שלום   ,המשך ,";
  expect(normalizeDraftCommas(s)).toBe("מכתב (חדש), שלום, המשך,");
  expect(normalizeDraftCommas(normalizeDraftCommas(s))).toBe(normalizeDraftCommas(s));
  expect(normalizeDraftCommas("עברית English ,word; סכום 1,000 ו־1 ,000")).toBe("עברית English ,word; סכום 1,000 ו־1 ,000");
  expect(normalizeDraftCommas("שלום , עולם . עוד ; בדיקה : מה ? כן !")).toBe("שלום , עולם . עוד ; בדיקה : מה ? כן !");
  expect(normalizeDraftCommas("שלום\u00a0,world")).toBe("שלום, world");
  expect(normalizeDraftCommas("סעיף 15 ,\nסעיף 16 ,")).toBe("סעיף 15,\nסעיף 16,");
});

it("audits text and hashes and remaps attention offsets", () => {
  const payload = { candidate_text: "א   ,ב", attention_spans: [[5, 6]] };
  const a = commaSpacingRevision("line_verify", payload, "old")!;
  expect(a.payload).toEqual({
    candidate_text: "א, ב", attention_spans: [[3, 4]],
    original_comma_spacing: { content_sha256: "old", fields: payload },
  });
  expect(a.contentSha256).not.toBe("old");
  expect(commaSpacingRevision("line_verify", a.payload, a.contentSha256)).toBeNull();
  expect(commaSpacingRevision("line_verify", { ...payload, gold: { id: 1 } }, "old")).toBeNull();
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync("migrations").filter(name => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync("migrations/" + name, "utf8"));
  }
  return db;
}

it("guards the backfill against concurrent visits and scopes it to open proposals", () => {
  const db = fixture();
  try {
    db.exec(`
      INSERT INTO reviewers(id, created_at, last_seen_at) VALUES ('rv_12345678','2026-11-21','2026-11-21');
      INSERT INTO batches(id,task_type,title,source_json,status,imported_at) VALUES
        ('open','line_verify','Fixture','{}','open','now'),('closed','line_verify','Fixture','{}','closed','now');
      INSERT INTO items(id,batch_id,external_id,title,payload_json) VALUES (1,'open','page','Fixture','{}'),(2,'closed','page','Fixture','{}');
      INSERT INTO proposals(id,batch_id,item_id,external_id,category,confidence,rank,payload_json,media_json,content_sha256)
        VALUES (1,'open',1,'l1','a','a',0,'{"candidate_text":"מילה ,שנייה ."}','{}','hash1'),
        (2,'open',1,'l2','a','a',1,'{"candidate_text":"מילה ,שנייה ,"}','{}','hash2'),
        (3,'closed',2,'l3','a','a',1,'{"candidate_text":"מילה ,שנייה"}','{}','hash3');
    `);
    const plan = planCommaBackfill(db.prepare(commaDraftsSql).all() as unknown as CommaDraftRow[]);
    expect(plan.queues["open/review"]).toMatchObject({ changes: 2, other_punctuation: { ".": 1 } });
    expect(plan.queues["closed/review"]).toBeUndefined();
    db.exec("INSERT INTO assignments(proposal_id,reviewer_id,assigned_at) VALUES (2,'rv_12345678',1)");
    for (const update of plan.updates) db.exec(guardedCommaUpdate(update));
    const texts = db.prepare("SELECT json_extract(payload_json,'$.candidate_text') text FROM proposals ORDER BY id").all();
    expect(texts.map(row => row.text)).toEqual(["מילה, שנייה .", "מילה ,שנייה ,", "מילה ,שנייה"]);
    expect(planCommaBackfill(db.prepare(commaDraftsSql).all() as unknown as CommaDraftRow[]).queues["open/review"])
      .toMatchObject({ changes: 0, already_served: 1 });
  } finally {
    db.close();
  }
});

it("normalizes new imports, preserves registered plants and keeps pending human edits", () => {
  const db = fixture();
  try {
    const candidate = "דוגמה ,בדיקה";
    const bundle: ImportBundle = {
      batch: { id: "fixture", taskType: "line_verify", title: "Fixture", source: {} },
      items: [{ externalId: "page", title: "Fixture", payload: {}, imageStem: null }],
      proposals: ["new", "reviewed", "planted"].map((externalId, rank) => ({
        externalId, itemExternalId: "page", category: "a", confidence: "a", rank,
        payload: { candidate_text: candidate }, pageBox: null, contentKey: { candidate },
      })),
    };
    const date = { minReviewers: 1, importedAt: "now" };
    db.exec(buildImportSql({
      ...bundle, proposals: [bundle.proposals[1]!],
    }, new Map(), { ...date, planted: new Set(["reviewed"]) }));
    db.exec(`INSERT INTO reviewers(id,created_at,last_seen_at) VALUES ('rv_12345678','2026-11-21','2026-11-21');
      INSERT INTO decisions(id,proposal_id,reviewer_id,value,text,proposal_sha256,terms_version,created_at,decided_on)
      SELECT 'd1',id,'rv_12345678','edited','עריכה משלי',content_sha256,'v1','now','2026-11-21' FROM proposals;
    `);
    db.exec(buildImportSql(bundle, new Map(), { ...date, planted: new Set(["planted"]) }));
    const rows = db.prepare("SELECT external_id, json_extract(payload_json,'$.candidate_text') AS text FROM proposals ORDER BY external_id").all();
    expect(rows.map(row => row.text)).toEqual(["דוגמה, בדיקה", candidate, candidate]);
    expect(db.prepare("SELECT text FROM decisions").get()?.text).toBe("עריכה משלי");
  } finally {
    db.close();
  }
});
