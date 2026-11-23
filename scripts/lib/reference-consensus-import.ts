import { createHash } from "node:crypto";
import { ALLOWED_REFERENCE_PROPOSAL } from "../../src/tasks/restricted_reference";
import { lit } from "./sql";

const sha = /^[a-f0-9]{64}$/;
const pin = (x: string) => sha.test(x);
const key = /^[a-zA-Z0-9_.:#-]{1,200}$/;
const policyReaders = new Map([
  ["36cdefdd17ec1e039757f623b1b3f80d5e4a7a4f6c62097a35cd7f105aa49081", 2],
  ["ec3dd271e5bbdaaa9c976a4d42ca8fbb294b6d6cc37d923e9c5c40a98c028ed7", 3],
]);
const digest = (x: Buffer | string) => createHash("sha256").update(x).digest("hex");

interface ProjectionLine {
  item_id: string; page_id: string; proposal_sha256: string; crop_sha256: string;
  draft_sha256: string; geometry_sha256: string; disposition: string; audit: boolean;
  source_verified: boolean; geometry_verified: boolean; draft_independent: boolean;
}
interface FrozenLine extends ProjectionLine { box_px: number[]; page_sha256: string; crop_ref: string; }
interface Projection {
  schema: string; batch_id: string; status: string; batch_ratification_sha256: string; freeze_sha256: string;
  protocol_sha256: string; rows: ProjectionLine[]; ordinary_queue: string[]; audit_queue: string[];
  counts: Record<string, number>; vote_files_sha256: Record<string, string>;
}
interface Freeze {
  schema: string; batch_id: string; protocol_sha256: string; batch_ratification_sha256: string;
  rows: FrozenLine[]; structural_page_tasks: number;
}
interface Ratification {
  schema: string; status: string; protocol_sha256: string; batch_id: string; counts: Record<string, number>;
  projection_sha256: string; freeze_sha256: string; batch_ratification_sha256: string;
  separate_page_tasks: number; pending_ordinary_lines: number; pending_blind_audit_lines: number;
  vote_files_sha256: Record<string, string>;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function recordEqual<T>(a: Record<string, T>, b: Record<string, T>) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
}

export function readReferencePlan(projection: Buffer, freeze: Buffer, ratification: Buffer, approvalPin: string, itemsPin: string) {
  check(pin(approvalPin) && pin(itemsPin) && digest(ratification) === approvalPin, "invalid approval or imported items pin");
  const approved = JSON.parse(ratification.toString()) as Ratification;
  const readerCount = policyReaders.get(approved.protocol_sha256);
  check(approved.schema === "heocr.open_reference_evaluator_ratification.v1" &&
    approved.status === "ratified_for_consensus_reference_prep" && readerCount !== undefined &&
    approved.projection_sha256 === digest(projection) && approved.freeze_sha256 === digest(freeze), "projection or freeze is outside ratification");
  const doc = JSON.parse(projection.toString()) as Projection;
  const frozen = JSON.parse(freeze.toString()) as Freeze;
  check(doc.schema === "heocr.open_reference_projection.v1" &&
    frozen.schema === "heocr.open_reference_freeze.v1" && doc.batch_id === frozen.batch_id &&
    doc.batch_id === approved.batch_id && /^private-ref-[a-zA-Z0-9_.-]{1,88}$/.test(doc.batch_id) &&
    doc.freeze_sha256 === approved.freeze_sha256 && doc.protocol_sha256 === approved.protocol_sha256 &&
    frozen.protocol_sha256 === approved.protocol_sha256 &&
    doc.batch_ratification_sha256 === approved.batch_ratification_sha256 &&
    frozen.batch_ratification_sha256 === approved.batch_ratification_sha256 &&
    frozen.structural_page_tasks === approved.separate_page_tasks &&
    recordEqual(approved.counts, doc.counts) && recordEqual(approved.vote_files_sha256, doc.vote_files_sha256), "approval envelope differs");
  const votePins = Object.values(approved.vote_files_sha256);
  check(votePins.length === readerCount && votePins.every(pin) &&
    new Set(votePins).size === readerCount, "ratified vote files differ from the reader count");
  check(doc.rows.length > 0 && doc.rows.length === frozen.rows.length && doc.rows.length <= 10000 &&
    doc.ordinary_queue.length === approved.pending_ordinary_lines && doc.audit_queue.length === approved.pending_blind_audit_lines,
  "ratified queue totals differ");
  const frozenById = new Map(frozen.rows.map(row => [row.item_id, row]));
  const order = new Map<string, { lane: "ordinary" | "audit"; position: number }>();
  for (const [lane, ids] of [["ordinary", doc.ordinary_queue], ["audit", doc.audit_queue]] as const) {
    ids.forEach((id, position) => {
      check(!order.has(id), "repeated queue item");
      order.set(id, { lane, position });
    });
  }
  const used = new Set<string>();
  let agreement = 0;
  let disagreements = 0;
  let structural = 0;
  const rows = doc.rows.map(row => {
    const source = frozenById.get(row.item_id);
    check(source && key.test(row.item_id) && key.test(row.page_id) && !used.has(row.item_id) &&
      [row.proposal_sha256, row.draft_sha256, row.crop_sha256, row.geometry_sha256, source.page_sha256].every(pin)
      && source.page_id === row.page_id && source.crop_sha256 === row.crop_sha256 &&
      source.geometry_sha256 === row.geometry_sha256 && source.proposal_sha256 === row.proposal_sha256 &&
      source.draft_sha256 === row.draft_sha256 && source.crop_ref.startsWith(row.crop_sha256 + ".") &&
      /\.(png|jpg|jpeg|webp)$/.test(source.crop_ref) && source.box_px.length === 4 &&
      source.box_px.every(n => Number.isFinite(n) && n >= 0) && source.box_px[0]! < source.box_px[2]! &&
      source.box_px[1]! < source.box_px[3]!, "row differs from exact frozen media, box or draft pin");
    used.add(row.item_id);
    const lane = order.get(row.item_id);
    if (row.disposition === "consensus_preaccepted") {
      check(row.source_verified && row.geometry_verified && row.draft_independent &&
        (row.audit ? lane?.lane === "audit" : !lane), "invalid agreement or audit membership");
      return { ...source, ...(lane ?? { lane: "accepted" as const, position: agreement++ }) };
    }
    check(lane?.lane === "ordinary" && row.audit === false &&
      (row.disposition === "disagreement" || row.disposition === "structural"), "invalid ordinary queue membership");
    if (row.disposition === "disagreement") disagreements++;
    else structural++;
    return { ...source, ...lane };
  });
  check(frozenById.size === used.size && [...order.keys()].every(id => used.has(id)) &&
    rows.length === doc.counts.pending && agreement + doc.audit_queue.length === doc.counts.consensus_preaccepted &&
    disagreements === doc.counts.disagreement && structural === doc.counts.structural && doc.audit_queue.length === doc.counts.audit,
  "ratified partition differs");
  return { batch: doc.batch_id, projectionPin: approved.projection_sha256, approvalPin, itemsPin, rows,
    agreed: agreement, audit: doc.audit_queue.length, ordinary: doc.ordinary_queue.length, pages: approved.separate_page_tasks };
}

export type ReferencePlan = ReturnType<typeof readReferencePlan>;
export interface LiveReferenceLine {
  id: number; item_id: number; item_external: string; external_id: string;
  sha: string; candidate: string; crop: string; page: string; box: string;
  human: number; skipped: number; page_complete: number;
}
export const REVIEW_SCOPE = `b.restricted_reference=1 AND b.task_type='line_verify' AND b.status='open'
  AND json_extract(b.source_json,'$.restricted_review')='draft_verification'`;
const lineScope = `p.active=1 AND ${ALLOWED_REFERENCE_PROPOSAL}
  AND COALESCE(json_extract(p.payload_json,'$.pass'),1)=1 AND (p.gate_kind IS NULL OR p.gate_kind='always')
  AND json_extract(p.payload_json,'$.candidate_provenance')='reference_draft'
  AND json_extract(p.payload_json,'$.gold') IS NULL
  AND json_extract(p.media_json,'$.crop.ref.source')='r2' AND json_extract(p.media_json,'$.page.ref.source')='r2'`;

function currentAnswer(reviewer: string) {
  return `EXISTS(SELECT 1 FROM decisions d WHERE d.proposal_id=p.id AND d.reviewer_id=${lit(reviewer)}
    AND d.superseded_at IS NULL AND d.proposal_sha256=p.content_sha256)`;
}

export function liveReferenceSql(plan: ReferencePlan, reviewer: string) {
  const who = lit(reviewer);
  return `SELECT p.id,p.item_id,i.external_id AS item_external,p.external_id,p.content_sha256 AS sha,
    json_extract(p.payload_json,'$.candidate_text') AS candidate,json_extract(p.payload_json,'$.box') AS box,
    json_extract(p.media_json,'$.crop.ref.key') AS crop,json_extract(p.media_json,'$.page.ref.key') AS page,
    ${currentAnswer(reviewer)} AS human,
    EXISTS(SELECT 1 FROM skips s WHERE s.proposal_id=p.id AND s.reviewer_id=${who}) AS skipped,
    EXISTS(SELECT 1 FROM page_checks pc WHERE pc.item_id=i.id AND pc.reviewer_id=${who}
      AND pc.superseded_at IS NULL AND pc.answer IN ('complete','lines_added')) AS page_complete
    FROM proposals p JOIN items i ON i.id=p.item_id AND i.batch_id=p.batch_id JOIN batches b ON b.id=p.batch_id
    WHERE b.id=${lit(plan.batch)} AND ${REVIEW_SCOPE} AND ${lineScope}
      AND json_extract(b.source_json,'$.items_sha256')=${lit(plan.itemsPin)}`;
}

export function matchReferenceRows(plan: ReferencePlan, live: LiveReferenceLine[]) {
  const byKey = new Map(live.map(row => [row.external_id, row]));
  check(byKey.size === live.length, "live roster differs");
  const matched = plan.rows.map(expected => {
    const row = byKey.get(expected.item_id);
    check(row && row.item_external === expected.page_id && row.sha === expected.proposal_sha256 &&
      typeof row.candidate === "string" && digest(row.candidate) === expected.draft_sha256 &&
      row.crop === expected.crop_ref && row.page.startsWith(expected.page_sha256 + ".") &&
      row.box === JSON.stringify(expected.box_px) &&
      digest(JSON.stringify({ page_sha256: expected.page_sha256, box: expected.box_px })) === expected.geometry_sha256,
    "current draft, page, crop or box changed");
    byKey.delete(expected.item_id);
    return { ...expected, db: row };
  });
  check([...byKey.values()].every(row => row.human === 1), "live roster contains unanswered lines outside the projection");
  return matched;
}

export function referenceStageSql(plan: ReferencePlan, rows: ReturnType<typeof matchReferenceRows>) {
  const run = lit(plan.projectionPin);
  const sql = [`INSERT INTO reference_consensus_runs (projection_sha256,batch_id,items_sha256,ratification_sha256,rows_expected)
    VALUES (${run},${lit(plan.batch)},${lit(plan.itemsPin)},${lit(plan.approvalPin)},${rows.length}) ON CONFLICT DO NOTHING;`];
  for (let offset = 0; offset < rows.length; offset += 40) {
    const values = rows.slice(offset, offset + 40).map(x =>
      `(${run},${x.db.id},${x.db.item_id},${lit(x.db.sha)},${lit(x.db.crop)},${lit(x.db.page)},${lit(x.db.box)},${lit(x.lane)},${x.position})`);
    sql.push(`INSERT INTO reference_consensus_lines VALUES ${values.join(",")} ON CONFLICT DO NOTHING;`);
  }
  return sql.join("\n") + "\n";
}

export function referenceActivateSql(plan: ReferencePlan, reviewer: string) {
  const joined = `FROM reference_consensus_lines l JOIN proposals p ON p.id=l.proposal_id AND p.item_id=l.item_id AND p.batch_id=rr.batch_id
    JOIN batches b ON b.id=rr.batch_id WHERE l.projection_sha256=rr.projection_sha256
      AND ${REVIEW_SCOPE} AND ${lineScope} AND json_extract(b.source_json,'$.items_sha256')=rr.items_sha256
      AND p.content_sha256=l.proposal_sha256 AND json_extract(p.media_json,'$.crop.ref.key')=l.crop_key
      AND json_extract(p.media_json,'$.page.ref.key')=l.page_key AND json_extract(p.payload_json,'$.box')=l.line_box`;
  return `UPDATE reference_consensus_runs AS rr SET active=1
    WHERE rr.projection_sha256=${lit(plan.projectionPin)} AND rr.batch_id=${lit(plan.batch)}
      AND rr.ratification_sha256=${lit(plan.approvalPin)} AND rr.items_sha256=${lit(plan.itemsPin)}
      AND rr.rows_expected=${plan.rows.length} AND rr.active=0
      AND rr.rows_expected=(SELECT COUNT(*) ${joined})
      AND NOT EXISTS (
        SELECT 1 FROM proposals p JOIN batches b ON b.id=p.batch_id
        WHERE b.id=rr.batch_id AND ${REVIEW_SCOPE} AND ${lineScope}
          AND NOT ${currentAnswer(reviewer)}
          AND NOT EXISTS (SELECT 1 FROM reference_consensus_lines l
            WHERE l.projection_sha256=rr.projection_sha256 AND l.proposal_id=p.id)
      )`;
}
