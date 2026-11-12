/** Which reserve pages are open (gate 'reserve', migrations/0002_proposal_gates.sql). Pure: shared with the tests. */

export interface ReserveRow {
  id: number;
  category: string;
  gate_kind: string | null;
  rejected: number;
}

/**
 * Which reserve proposals are open: every rejected page (an ungated one, or an open reserve itself rejected), in
 * rank order, takes the first unused reserve of its category, else the first unused one in rank order.
 */
export function assignReserves(rows: ReserveRow[]): number[] {
  const reserves = rows.filter((r) => r.gate_kind === "reserve");
  if (!reserves.length) return [];
  const used = new Set<number>();
  const queue = rows.filter((r) => r.gate_kind === null && r.rejected);
  for (let k = 0; k < queue.length; k++) {
    const r = queue[k]!;
    const pick = reserves.find((x) => !used.has(x.id) && x.category === r.category) ?? reserves.find((x) => !used.has(x.id));
    if (!pick) break;
    used.add(pick.id);
    if (pick.rejected) queue.push(pick);
  }
  return [...used];
}

