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
const key = { batch_id: batch, protocol_sha256: protocol, batch_ratification_sha256: "e".repeat(64) };
const box = [1, 2, 9, 8];
const candidate = "שורה אחת";
const row = { item_id: "line1", page_id: "page1", proposal_sha256: projectionPin,
  draft_sha256: digest(candidate), crop_sha256: crop, geometry_sha256: digest(JSON.stringify({ page_sha256: page, box })),
  disposition: "consensus_preaccepted", audit: false,
  source_verified: true, geometry_verified: true, draft_independent: true };

function envelopes(ordinary: string[] = []) {
  const freeze = encode({ ...key, schema: "heocr.open_reference_freeze.v1", structural_page_tasks: 1,
    rows: [{ ...row, page_sha256: page, box_px: box, crop_ref: crop + ".jpg" }] });
  const counts = { pending: 1, consensus_preaccepted: 1, disagreement: 0, structural: 0, audit: 0 };
  const vote_files_sha256 = { a: "1".repeat(64), b: "2".repeat(64) };
  const projection = encode({ ...key, schema: "heocr.open_reference_projection.v1", freeze_sha256: digest(freeze),
    rows: [row], counts, ordinary_queue: ordinary, audit_queue: [], vote_files_sha256 });
  const approval = encode({ ...key, schema: "heocr.open_reference_evaluator_ratification.v1",
    status: "ratified_for_consensus_reference_prep", projection_sha256: digest(projection),
    freeze_sha256: digest(freeze), separate_page_tasks: 1, pending_ordinary_lines: ordinary.length,
    pending_blind_audit_lines: 0, counts, vote_files_sha256 });
  return { freeze, projection, approval };
}

it("refuses tampered approvals and acceptance duplicated in the human queue", () => {
  const { freeze, projection, approval } = envelopes();
  expect(() => readReferencePlan(projection, freeze, approval, items, items)).toThrow(/approval/);
  expect(() => readReferencePlan(Buffer.from(""), freeze, approval, digest(approval), items)).toThrow(/outside/);
  const duplicated = envelopes(["line1"]);
  expect(() => readReferencePlan(duplicated.projection, duplicated.freeze, duplicated.approval, digest(duplicated.approval), items))
    .toThrow(/membership/);
});

it("holds a changed geometry stage, then activates exact routing without writing a human answer", () => {
  const { freeze, projection, approval } = envelopes();
  const plan = readReferencePlan(projection, freeze, approval, digest(approval), items);
  using db = new DatabaseSync(":memory:");
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
  const live = () => db.prepare(liveReferenceSql(plan, reviewer)).all() as unknown as LiveReferenceLine[];
  const exact = matchReferenceRows(plan, live());
  db.exec(referenceStageSql(plan, exact));
  expect(db.prepare("SELECT COUNT(*) AS n FROM current_reference_consensus_lines").get()!.n).toBe(0);
  db.exec("UPDATE proposals SET payload_json=json_set(payload_json,'$.box',json('[0,2,9,8]'))");
  expect(() => matchReferenceRows(plan, live())).toThrow(/current draft/);
  expect(db.prepare(referenceActivateSql(plan)).run().changes).toBe(0);
  db.exec("UPDATE proposals SET payload_json=json_set(payload_json,'$.box',json('[1,2,9,8]'))");
  expect(db.prepare(referenceActivateSql(plan)).run().changes).toBe(1);
  expect(db.prepare(referenceActivateSql(plan)).run().changes).toBe(0);
  expect(db.prepare("SELECT lane FROM current_reference_consensus_lines").get()!.lane).toBe("accepted");
  expect(db.prepare("SELECT COUNT(*) AS n FROM decisions").get()!.n).toBe(0);
});
