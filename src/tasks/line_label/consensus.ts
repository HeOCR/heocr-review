/**
 * Volunteer line labelling: when a line's decisions make a reference (maintainer's rule, 2026-11-18). Pure: no I/O.
 *
 * - A line is a reference when two volunteers agree independently.
 * - If the first two disagree, a third volunteer decides: a line is a reference when two of the three agree.
 * - If all three differ, the line goes to the admin queue, and the admin's decision is final.
 *
 * Only decisions that count take part: a reviewer excluded by an admin, or below eval's accuracy floor on gold lines,
 * does not count (their decisions are kept and exported, marked as not counted). The outcome uses the first counting
 * decisions in the order the reviewers first decided the line, so an extra decision from a concurrent reviewer never
 * changes an agreement already reached.
 *
 * Agreement compares answer keys: the action's class and, for text actions, the normalised text. The normalisation
 * is eval's (registration amendment); `normalizeForAgreement` must stay exactly theirs.
 */

export const LINE_VALUES = ["correct", "edit", "unreadable", "not_on_page", "print_has_niqqud"] as const;
export type LineValue = (typeof LINE_VALUES)[number];
export const TEXT_VALUES: readonly LineValue[] = ["edit", "print_has_niqqud"];

/**
 * PENDING eval's amendment: NFC, whitespace runs folded to one space, ends trimmed. Replaced with eval's exact
 * definition before any export is used as a reference.
 */
export function normalizeForAgreement(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export interface Answer {
  value: LineValue;
  /** The reviewer's text for edit and print_has_niqqud (print_has_niqqud without text: the pre-fill's letters). */
  text: string | null;
}

/**
 * The key two answers agree on. `correct` is the pre-fill's text, so it agrees with an edit that normalises to the
 * pre-fill. `print_has_niqqud` is its own class (the letters, plus "the print is pointed"). unreadable and
 * not_on_page agree only with themselves.
 */
export function answerKey(prefill: string, a: Answer, normalize = normalizeForAgreement): string {
  switch (a.value) {
    case "correct":
      return `text\u0000${normalize(prefill)}`;
    case "edit":
      return `text\u0000${normalize(a.text ?? "")}`;
    case "print_has_niqqud":
      return `niqqud\u0000${normalize(a.text ?? prefill)}`;
    default:
      return a.value;
  }
}

export interface Vote extends Answer {
  reviewerId: string;
  /** When this reviewer first decided the line (ISO); orders the votes. */
  firstAt: string;
  counts: boolean;
}

export type Outcome =
  /** More counting decisions are needed: `needed` more reviewers should get the line. */
  | { state: "pending"; needed: 1 | 2; counted: number }
  /** The first two counting decisions agree. */
  | { state: "agreed"; answer: Answer; reviewers: string[] }
  /** The first two disagreed and the third agrees with one of them. */
  | { state: "majority"; answer: Answer; reviewers: string[] }
  /** All three differ: waiting for an admin. */
  | { state: "admin_queue"; reviewers: string[] }
  /** An admin decided a line from the admin queue. */
  | { state: "admin"; answer: Answer; reviewers: string[] };

/** The answer to publish for agreeing votes: the earliest of them (their keys are equal). */
function representative(votes: Vote[]): Answer {
  const v = votes[0]!;
  return { value: v.value, text: v.text };
}

export function outcome(prefill: string, votes: Vote[], adjudication: Answer | null, normalize = normalizeForAgreement): Outcome {
  const counted = votes
    .filter((v) => v.counts)
    .slice()
    .sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : a.reviewerId.localeCompare(b.reviewerId)));
  const key = (v: Vote) => answerKey(prefill, v, normalize);
  if (counted.length < 2) return { state: "pending", needed: counted.length === 0 ? 2 : 1, counted: counted.length };
  const [a, b] = [counted[0]!, counted[1]!];
  if (key(a) === key(b)) return { state: "agreed", answer: representative([a, b]), reviewers: [a.reviewerId, b.reviewerId] };
  if (counted.length < 3) return { state: "pending", needed: 1, counted: 2 };
  const c = counted[2]!;
  const three = [a.reviewerId, b.reviewerId, c.reviewerId];
  const match = [a, b].find((v) => key(v) === key(c));
  if (match) return { state: "majority", answer: representative([match, c]), reviewers: three };
  if (adjudication) return { state: "admin", answer: adjudication, reviewers: three };
  return { state: "admin_queue", reviewers: three };
}

/** How many more counting reviewers a line needs (0 once it has an outcome or is waiting for an admin). */
export function neededOf(o: Outcome): number {
  return o.state === "pending" ? o.needed : 0;
}

export interface GoldRule {
  /** Below this share of gold hits a reviewer stops counting (eval's floor). */
  floor: number;
  /** A reviewer counts until they have answered this many gold lines. */
  minGold: number;
}

export interface Standing {
  answered: number;
  hits: number;
  /** hits / answered, or null before the first gold answer. */
  accuracy: number | null;
  counts: boolean;
  reason: "ok" | "too_few_gold" | "below_floor" | "excluded";
}

/** Whether a reviewer's decisions count toward agreement, from their gold answers and the admin switch. */
export function standing(hits: boolean[], rule: GoldRule, excluded: boolean): Standing {
  const answered = hits.length;
  const h = hits.filter(Boolean).length;
  const accuracy = answered ? h / answered : null;
  if (excluded) return { answered, hits: h, accuracy, counts: false, reason: "excluded" };
  if (answered < rule.minGold) return { answered, hits: h, accuracy, counts: true, reason: "too_few_gold" };
  if (accuracy! < rule.floor) return { answered, hits: h, accuracy, counts: false, reason: "below_floor" };
  return { answered, hits: h, accuracy, counts: true, reason: "ok" };
}

/** A gold answer is a hit when it agrees with the gold line's answer under the same key. */
export function goldHit(prefill: string, answer: Answer, gold: Answer, normalize = normalizeForAgreement): boolean {
  return answerKey(prefill, answer, normalize) === answerKey(prefill, gold, normalize);
}
