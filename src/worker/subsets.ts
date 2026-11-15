/** Which proposal each stratum of a subset serves (migrations/0003_subsets.sql). Pure: shared with the tests. */
import { EXCLUDED_ACTIONS } from "../tasks/page_review/schema";

export interface SubsetMemberRow {
  stratum: string;
  position: number;
  /** null when the batch has no such proposal. */
  proposal_id: number | null;
  active: number | null;
}

export interface CurrentDecisionRow {
  proposal_id: number;
  value: string;
  text: string | null;
}

/**
 * A current decision that takes a page out of a subset: a rejection, or a page_review confirm with no reference line
 * (every line marked not on the page or unreadable), which leaves nothing to score.
 */
export function takesOut(d: { value: string; text: string | null }): boolean {
  if (d.value === "reject") return true;
  if (d.value !== "confirm" || !d.text) return false;
  try {
    const parsed = JSON.parse(d.text) as { lines?: unknown };
    if (!Array.isArray(parsed.lines)) return false;
    return parsed.lines.every((l) => EXCLUDED_ACTIONS.includes((l as { action?: never }).action as never));
  } catch {
    return false;
  }
}

/**
 * Per stratum, the first member (by position: the pick, then its alternates) whose proposal is active and has no
 * current decision that takes it out. A stratum whose members are all out serves nothing. Returns the proposal ids
 * served and the number of strata.
 */
export function servedMembers(members: SubsetMemberRow[], decisions: CurrentDecisionRow[]): { ids: number[]; strata: number } {
  const out = new Set(decisions.filter(takesOut).map((d) => d.proposal_id));
  const byStratum = new Map<string, SubsetMemberRow[]>();
  for (const m of members) byStratum.set(m.stratum, [...(byStratum.get(m.stratum) ?? []), m]);
  const ids: number[] = [];
  for (const list of byStratum.values()) {
    const pick = list
      .slice()
      .sort((a, b) => a.position - b.position)
      .find((m) => m.proposal_id !== null && m.active === 1 && !out.has(m.proposal_id));
    if (pick) ids.push(pick.proposal_id!);
  }
  return { ids, strata: byStratum.size };
}
