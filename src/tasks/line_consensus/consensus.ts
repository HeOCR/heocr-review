/**
 * Volunteer line review: when volunteers' decisions on a line agree, who counts, and when a gold line is due. Pure.
 *
 * The rule is the maintainer's (2026-11-18): a line is a reference when two volunteers agree on it independently; if
 * they disagree a third volunteer decides; if there is still no majority, the line goes to the maintainer.
 *
 * This is a port of eval's reference implementation, heocr-restricted-eval
 * preregistration/midcentury_volunteers_2026-11-18/agreement.py (norm, value, agree, resolve, gold_hit), and of \u00a74
 * of that amendment (gold rate and floor). The app's results are for routing; eval's ingest recomputes everything
 * from the export with agreement.py and stops on any difference, so this file must give the same answers on its
 * CASES (test/node/line_consensus.test.ts holds them, verbatim).
 */

export const LINE_ACTIONS = ["correct", "edit", "print_has_niqqud", "unreadable", "not_on_page"] as const;
export type LineAction = (typeof LINE_ACTIONS)[number];
/** Actions whose decision carries the volunteer's final text. */
export const TEXT_ACTIONS: readonly LineAction[] = ["edit", "print_has_niqqud"];

/** Invisible bidi formatting: LRM, RLM, ALM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI. */
const BIDI = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu;
/** Every code point with the Unicode White_Space property (agreement.py's _WS, the same set), in runs. */
const WS = /[\u0009-\u000d \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
/** What Python's str.strip() also strips after _WS: the separators U+001C-U+001F (str.isspace() but not White_Space). */
const PY_STRIP = /^[\u001c-\u001f ]+|[\u001c-\u001f ]+$/gu;

/** agreement.norm: NFC; delete bidi formatting; every White_Space run becomes one U+0020; strip both ends. */
export function norm(s: string): string {
  return s.normalize("NFC").replace(BIDI, "").replace(WS, " ").replace(PY_STRIP, "");
}

export interface LineDecision {
  action: LineAction;
  /** The final text for edit and print_has_niqqud; ignored for the other actions. */
  text?: string | null;
}

/** agreement.value: (class, value), as one string; two decisions agree when it is equal. */
export function value(d: LineDecision, prefill: string): string {
  switch (d.action) {
    case "correct":
      return `text\u0000${norm(prefill)}`;
    case "edit":
      return `text\u0000${norm(d.text ?? "")}`;
    case "print_has_niqqud": // a consonantal-only reference: its own class, never equal to a text decision
      return `niqqud\u0000${norm(d.text ?? "")}`;
    case "unreadable":
    case "not_on_page":
      return d.action; // agree only with the same action
    default:
      throw new Error(`unknown action ${JSON.stringify((d as { action: unknown }).action)}`);
  }
}

export function agree(a: LineDecision, b: LineDecision, prefill: string): boolean {
  return value(a, prefill) === value(b, prefill);
}

export type Resolution =
  | { status: "pending" | "needs_third" | "to_maintainer"; reference: null }
  | { status: "agreed" | "majority"; reference: string };

/** agreement.resolve: counted decisions in decision order, each from a different reviewer id. */
export function resolve(decisions: LineDecision[], prefill: string): Resolution {
  const vs = decisions.map((d) => value(d, prefill));
  if (vs.length < 2) return { status: "pending", reference: null };
  if (vs[0] === vs[1]) return { status: "agreed", reference: vs[0]! };
  if (vs.length === 2) return { status: "needs_third", reference: null };
  if (vs[2] === vs[0] || vs[2] === vs[1]) return { status: "majority", reference: vs[2]! };
  return { status: "to_maintainer", reference: null };
}

/** agreement.gold_hit: the decision, on the pre-fill the volunteer saw, agrees with the gold answer. */
export function goldHit(d: LineDecision, gold: LineDecision, prefillShown: string): boolean {
  return value(d, prefillShown) === value(gold, gold.text ?? "");
}

// ---------------------------------------------------------------------------------------------------------------
// Who counts (\u00a74)

/** eval's pre-registered floor: 95%, applied once a volunteer has 20 gold lines; before 20, nothing counts yet. */
export const GOLD_FLOOR = 0.95;
export const GOLD_MIN = 20;

/**
 * counting: their decisions count. provisional: fewer than 20 gold lines so far, so none count yet (they will, in
 * decision order, once the volunteer reaches the floor). below_floor and excluded: none count, past ones included.
 * Only counting volunteers fill a line's slots: a line goes on being offered until it settles on counted decisions,
 * so a volunteer who stops before their 20th gold line never holds a line back.
 */
export type StandingState = "counting" | "provisional" | "below_floor" | "excluded";

export interface Standing {
  graded: number;
  hits: number;
  accuracy: number | null;
  state: StandingState;
}

export function standing(graded: number, hits: number, excluded: boolean): Standing {
  const accuracy = graded ? hits / graded : null;
  const state: StandingState = excluded ? "excluded" : graded < GOLD_MIN ? "provisional" : hits / graded >= GOLD_FLOOR ? "counting" : "below_floor";
  return { graded, hits, accuracy, state };
}

/** Why a decision does not count (the export's `counted: false` reason), or null when it counts. */
export function notCountedReason(s: StandingState): "fewer_than_20_gold" | "below_floor" | "excluded_by_admin" | null {
  return s === "counting" ? null : s === "provisional" ? "fewer_than_20_gold" : s === "below_floor" ? "below_floor" : "excluded_by_admin";
}

// ---------------------------------------------------------------------------------------------------------------
// A line's routing state

export interface Vote extends LineDecision {
  reviewerId: string;
  /** When the reviewer decided the line (ISO). Decisions are final: one per reviewer per line. */
  at: string;
  standing: StandingState;
}

export type LineState =
  /** `needed` more counting volunteers should decide the line. */
  | { state: "open"; needed: 1 | 2 }
  | { state: "agreed" | "majority"; needed: 0; reviewers: string[] }
  /** Three counted decisions and no majority: the maintainer's tie-break queue. */
  | { state: "to_maintainer"; needed: 0; reviewers: string[] };

function inOrder(votes: Vote[]): Vote[] {
  return votes.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.reviewerId.localeCompare(b.reviewerId)));
}

/** The counted decisions in decision order (what eval's resolve() takes). */
export function counted(votes: Vote[]): Vote[] {
  return inOrder(votes.filter((v) => v.standing === "counting"));
}

/** The line's state: resolve() over its counted decisions, in decision order. */
export function lineState(votes: Vote[], prefill: string): LineState {
  const c = counted(votes);
  const r = resolve(c, prefill);
  if (r.status === "pending") return { state: "open", needed: c.length === 0 ? 2 : 1 };
  if (r.status === "needs_third") return { state: "open", needed: 1 };
  const reviewers = c.slice(0, r.status === "agreed" ? 2 : 3).map((v) => v.reviewerId);
  if (r.status === "agreed" || r.status === "majority") return { state: r.status, needed: 0, reviewers };
  return { state: "to_maintainer", needed: 0, reviewers };
}

// ---------------------------------------------------------------------------------------------------------------
// Gold placement (\u00a74)

/** Gold lines due after `lines` real lines: 1 in 10 over the first 100, then 1 in 20. */
export function goldDue(lines: number): number {
  return lines <= 100 ? lines / 10 : 10 + (lines - 100) / 20;
}

/**
 * Whether the next line should be gold: once the lines due exceed the gold served so far by the reviewer's seed
 * offset (in [0, 1), from sha256("gold|" + reviewer_id)), so where gold falls differs per reviewer and cannot be
 * counted out. The first gold line falls among the reviewer's first 10 lines.
 */
export function goldNext(lines: number, goldServed: number, offset: number): boolean {
  return goldDue(lines) >= goldServed + offset;
}
