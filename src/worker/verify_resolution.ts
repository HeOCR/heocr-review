/**
 * line_verify volunteer resolution v1 in the Worker (docs/specs/line_verify_volunteer_resolution_v1.md): who a
 * volunteer_v1 line is open to, and what a decision on it records. The rules are in src/tasks/line_verify/resolution.ts;
 * this file only reads and writes D1 (migrations/0009_volunteer_resolution.sql).
 */
import { notCountedReason } from "../tasks/line_consensus/consensus";
import { standingOf } from "../tasks/line_consensus/index";
import type { LineVerifyPayload } from "../tasks/line_verify/index";
import { GATE_BATCH_ID, routeLine, type CountedVote, type LineRouting } from "../tasks/line_verify/resolution";

export { GATE_BATCH_ID };
import { VERIFY_VOTES_SQL, toVerifyVote, type VerifyVoteRow } from "../tasks/rows";
import type { BatchRecord, ProposalRecord, VerifyVote } from "../tasks/types";
import { standings } from "./consensus";


export const isVolunteerV1 = (batch: BatchRecord) => batch.taskType === "line_verify" && batch.settings?.resolution === "volunteer_v1";

/** SQL: volunteer_v1 line p's routing lets this reviewer (the admin or not) decide it next. */
export const volunteerOpen = (admin: boolean) =>
  `COALESCE((SELECT v.open_to FROM verify_state v WHERE v.proposal_id = p.id), 'anyone') IN ('anyone', '${admin ? "admin" : "non_admin"}')`;

/** SQL: volunteer_v1 line p is done (resolved or unresolved). */
export const VOLUNTEER_DONE = `COALESCE((SELECT v.open_to FROM verify_state v WHERE v.proposal_id = p.id), 'anyone') = 'nobody'`;

/** A line's routing from its current decisions and their verify_votes rows. */
export async function routingOf(db: D1Database, proposal: ProposalRecord): Promise<LineRouting> {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.reviewer_id, d.value, d.text, d.created_at, v.counted, v.by_admin FROM decisions d
       JOIN verify_votes v ON v.decision_id = d.id WHERE d.proposal_id = ?1 AND d.superseded_at IS NULL ORDER BY d.created_at, d.id`,
    )
    .bind(proposal.id)
    .all<{ id: string; reviewer_id: string; value: string; text: string | null; created_at: string; counted: number; by_admin: number }>();
  const counted: CountedVote[] = results
    .filter((r) => r.counted === 1)
    .map((r) => ({ decisionId: r.id, reviewerId: r.reviewer_id, value: r.value, text: r.text, createdAt: r.created_at }));
  const x = proposal.payload as unknown as LineVerifyPayload;
  return routeLine(counted, x.candidate_text, results.some((r) => r.by_admin === 1), x.kind ?? "verify");
}

/** Whether a reviewer may decide this volunteer_v1 line now (they have not decided it; its step lets them). */
export function openFor(routing: LineRouting, admin: boolean): boolean {
  return routing.openTo === "anyone" || (routing.openTo === "admin" && admin) || (routing.openTo === "non_admin" && !admin);
}

/**
 * Record what a new decision on a volunteer_v1 line is: counted or not (the reviewer's standing now; the maintainer
 * step counts by role), its step, and whether an admin made it; then recompute the line's routing. `before` is the
 * routing the decision was made under.
 */
export async function recordVolunteerDecision(
  db: D1Database,
  batch: BatchRecord,
  proposal: ProposalRecord,
  decisionId: string,
  reviewerId: string,
  admin: boolean,
  before: LineRouting,
  nowIso: string,
): Promise<LineRouting> {
  const atMaintainer = before.next === "maintainer" && admin;
  const reason = atMaintainer ? null : notCountedReason(standingOf(await standings(db, GATE_BATCH_ID, [reviewerId]), reviewerId).state);
  const counted = reason === null;
  const step = counted ? before.next! : "uncounted";
  await db
    .prepare("INSERT INTO verify_votes (decision_id, proposal_id, counted, not_counted_reason, step, by_admin) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(decisionId, proposal.id, counted ? 1 : 0, reason, step, admin ? 1 : 0)
    .run();
  const after = await routingOf(db, proposal);
  await db
    .prepare(
      `INSERT INTO verify_state (proposal_id, batch_id, resolution, open_to, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (proposal_id) DO UPDATE SET resolution = excluded.resolution, open_to = excluded.open_to, updated_at = excluded.updated_at`,
    )
    .bind(proposal.id, batch.id, after.resolution, after.openTo, nowIso)
    .run();
  return after;
}

/** The export's extra input: every decision's verify_votes row. */
export async function volunteerExtras(db: D1Database, batchId: string): Promise<{ verifyVotes: VerifyVote[] }> {
  const { results } = await db.prepare(VERIFY_VOTES_SQL).bind(batchId).all<VerifyVoteRow>();
  return { verifyVotes: results.map(toVerifyVote) };
}
