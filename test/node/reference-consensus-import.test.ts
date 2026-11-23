import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  liveReferenceSql, matchReferenceRows, readReferencePlan, referenceActivateSql, referenceStageSql, type LiveReferenceLine,
} from "../../scripts/lib/reference-consensus-import";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const batch = "private-ref-fixture";
const items = "a".repeat(64);
const projectionPin = "b".repeat(64);
const page = "c".repeat(64);
const crop = "d".repeat(64);
const reviewer = "rv_abcdef12";
const protocol = "36cdefdd17ec1e039757f623b1b3f80d5e4a7a4f6c62097a35cd7f105aa49081";
const amended = "ec3dd271e5bbdaaa9c976a4d42ca8fbb294b6d6cc37d923e9c5c40a98c028ed7";
const key = { batch_id: batch, protocol_sha256: protocol, batch_ratification_sha256: "e".repeat(64) };
const box = [1, 2, 9, 8];
const candidate = "שורה אחת";
const row = { item_id: "line1", page_id: "page1", proposal_sha256: projectionPin,
  draft_sha256: digest(candidate), crop_sha256: crop, geometry_sha256: digest(JSON.stringify({ page_sha256: page, box })),
  disposition: "consensus_preaccepted", audit: false,
  source_verified: true, geometry_verified: true, draft_independent: true };

function envelopes(ordinary: string[] = [], method = protocol, votePins = ["1".repeat(64), "2".repeat(64)]) {
  const binding = { ...key, protocol_sha256: method };
  const freeze = encode({ ...binding, schema: "heocr.open_reference_freeze.v1", structural_page_tasks: 1,
    rows: [{ ...row, page_sha256: page, box_px: box, crop_ref: crop + ".jpg" }] });
  const counts = { pending: 1, consensus_preaccepted: 1, disagreement: 0, structural: 0, audit: 0 };
  const vote_files_sha256 = Object.fromEntries(votePins.map((pin, i) => [`reader_${i}`, pin]));
  const projection = encode({ ...binding, schema: "heocr.open_reference_projection.v1", freeze_sha256: digest(freeze),
    rows: [row], counts, ordinary_queue: ordinary, audit_queue: [], vote_files_sha256 });
  const approval = encode({ ...binding, schema: "heocr.open_reference_evaluator_ratification.v1",
    status: "ratified_for_consensus_reference_prep", projection_sha256: digest(projection),
    freeze_sha256: digest(freeze), separate_page_tasks: 1, pending_ordinary_lines: ordinary.length,
    pending_blind_audit_lines: 0, counts, vote_files_sha256 });
  return { freeze, projection, approval };
}

it("binds the registered amendment to three distinct vote files", () => {
  const openPlan = ({ projection, freeze, approval }: ReturnType<typeof envelopes>) =>
    readReferencePlan(projection, freeze, approval, digest(approval), items);
  const threeVotes = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
  expect(openPlan(envelopes([], amended, threeVotes)).agreed).toBe(1);
  expect(() => openPlan(envelopes([], amended))).toThrow(/reader count/);
  expect(() => openPlan(envelopes([], amended, ["1".repeat(64), ...threeVotes.slice(0, 2)]))).toThrow(/reader count/);
  expect(() => openPlan(envelopes([], "4".repeat(64), threeVotes))).toThrow(/outside ratification/);
});

it("refuses tampered approvals and acceptance duplicated in the human queue", () => {
  const { freeze, projection, approval } = envelopes();
  expect(() => readReferencePlan(projection, freeze, approval, items, items)).toThrow(/approval/);
  expect(() => readReferencePlan(Buffer.from(""), freeze, approval, digest(approval), items)).toThrow(/outside/);
  const duplicated = envelopes(["line1"]);
  expect(() => readReferencePlan(duplicated.projection, duplicated.freeze, duplicated.approval, digest(duplicated.approval), items))
    .toThrow(/membership/);
});

function fixtureDb() {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  db.prepare(`INSERT INTO batches (id,task_type,title,source_json,min_reviewers,status,imported_at,restricted_reference)
    VALUES (?,'line_verify','fixture',?,1,'open','fixture',1)`).run(batch, JSON.stringify({ items_sha256: items, restricted_review: "draft_verification" }));
  db.prepare("INSERT INTO items (id,batch_id,external_id,title,payload_json) VALUES (1,?,'page1','fixture','{}')").run(batch);
  db.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id,first_allowed,blind_allowed) VALUES (?,1,1,0)").run(batch);
  db.prepare(`INSERT INTO proposals(id,batch_id,item_id,external_id,category,confidence,rank,payload_json,media_json,content_sha256,active)
    VALUES (1,?,1,'line1','fixture','fixture',0,?,?,?,1)`).run(batch,
    JSON.stringify({ box, candidate_text: candidate, candidate_provenance: "reference_draft" }),
    JSON.stringify({ page: { ref: { source: "r2", key: page + ".png" } }, crop: { ref: { source: "r2", key: crop + ".jpg" } } }),
    projectionPin);
  return db;
}

it("holds a changed geometry stage, then activates exact routing without writing a human answer", () => {
  const { freeze, projection, approval } = envelopes();
  const plan = readReferencePlan(projection, freeze, approval, digest(approval), items);
  using db = fixtureDb();
  const live = () => db.prepare(liveReferenceSql(plan, reviewer)).all() as unknown as LiveReferenceLine[];
  const exact = matchReferenceRows(plan, live());
  db.exec(referenceStageSql(plan, exact));
  expect(db.prepare("SELECT COUNT(*) AS n FROM current_reference_consensus_lines").get()!.n).toBe(0);
  db.exec("UPDATE proposals SET payload_json=json_set(payload_json,'$.box',json('[0,2,9,8]'))");
  expect(() => matchReferenceRows(plan, live())).toThrow(/current draft/);
  expect(db.prepare(referenceActivateSql(plan, reviewer)).run().changes).toBe(0);
  db.exec("UPDATE proposals SET payload_json=json_set(payload_json,'$.box',json('[1,2,9,8]'))");
  expect(db.prepare(referenceActivateSql(plan, reviewer)).run().changes).toBe(1);
  expect(db.prepare(referenceActivateSql(plan, reviewer)).run().changes).toBe(0);
  expect(db.prepare("SELECT lane FROM current_reference_consensus_lines").get()!.lane).toBe("accepted");
  expect(db.prepare("SELECT COUNT(*) AS n FROM decisions").get()!.n).toBe(0);
});

it("activates a pending-only projection if every excluded line has a current answer at cutover", () => {
  const { freeze, projection, approval } = envelopes();
  const plan = readReferencePlan(projection, freeze, approval, digest(approval), items);
  using db = fixtureDb();
  db.exec(`INSERT INTO proposals(id,batch_id,item_id,external_id,category,confidence,rank,payload_json,media_json,content_sha256,active)
    SELECT 2,batch_id,item_id,'line2',category,confidence,1,payload_json,media_json,content_sha256,active
    FROM proposals WHERE id=1`);
  const live = () => db.prepare(liveReferenceSql(plan, reviewer)).all() as unknown as LiveReferenceLine[];
  expect(() => matchReferenceRows(plan, live())).toThrow(/unanswered lines outside/);

  db.prepare("INSERT INTO reviewers (id,created_at,last_seen_at) VALUES (?,'fixture','fixture')").run(reviewer);
  db.prepare(`INSERT INTO decisions (id,proposal_id,reviewer_id,value,text,proposal_sha256,terms_version,created_at,decided_on)
    VALUES ('prior-answer',2,?,'edited',?,?,'fixture','fixture','2026-01-01')`).run(reviewer, "תיקון קודם", projectionPin);
  db.exec(referenceStageSql(plan, matchReferenceRows(plan, live())));
  const activate = db.prepare(referenceActivateSql(plan, reviewer));

  db.exec("UPDATE decisions SET superseded_at='fixture' WHERE id='prior-answer'");
  expect(activate.run().changes).toBe(0);
  db.exec("UPDATE decisions SET superseded_at=NULL,proposal_sha256='stale' WHERE id='prior-answer'");
  expect(activate.run().changes).toBe(0);
  db.prepare("UPDATE decisions SET proposal_sha256=? WHERE id='prior-answer'").run(projectionPin);
  const decisions = db.prepare("SELECT * FROM decisions");
  const before = decisions.all();

  expect(activate.run().changes).toBe(1);
  expect(db.prepare("SELECT proposal_id,lane FROM current_reference_consensus_lines").all())
    .toEqual([{ proposal_id: 1, lane: "accepted" }]);
  expect(decisions.all()).toEqual(before);
});
