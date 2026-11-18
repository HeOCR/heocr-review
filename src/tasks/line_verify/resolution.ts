/**
 * line_verify volunteer resolution v1 (docs/specs/line_verify_volunteer_resolution_v1.md): when decisions on a line
 * agree, and which step it is at. Pure; the Worker reads and writes D1 (src/worker/verify_resolution.ts).
 */

/** Whose standing counts: the mid-century volunteer batch's gold (as H). */
export const GATE_BATCH_ID = "newprinted_midcentury_volunteers_v0";

/** line_fold_v1 (heocr-eval, tasks/eval-domains/profiles/line_fold_v1.json), ported exactly. */
export const LINE_FOLD_V1_SHA256 = "2e2627104be4f27dc3204787dd3ff4f8591d95d1d96294c65833d2773041d317";
const FOLDS: Record<string, string> = { "\u05be": "-", "\u05f3": "'", "\u05f4": '"', "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2014": "\u2013" };
const FOLD_RE = new RegExp(`[${Object.keys(FOLDS).join("")}]`, "gu");

/**
 * NFC, then the folds, then every whitespace run becomes one space, stripped: Python's `" ".join(s.split())`, whose
 * whitespace is str.isspace() (Unicode White_Space plus U+001C-U+001F).
 */
export function lineFoldV1(s: string): string {
  return s
    .normalize("NFC")
    .replace(FOLD_RE, (c) => FOLDS[c]!)
    .split(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u)
    .filter(Boolean)
    .join(" ");
}

/** A decision as stored: the app value and its text (null when none). */
export interface StoredDecision {
  value: string;
  text: string | null;
}

/** Actions that agree only with the same action. */
const SAME_ACTION = ["unreadable", "not_one_line", "no_text", "continued", "misaligned"];

/**
 * A decision's value (spec, "When two decisions agree"): equal values agree. On a typed line (`kind` "type") there
 * is no candidate, so print-has-niqqud must carry its typed letters.
 */
export function decisionValue(d: StoredDecision, candidate: string, kind: "verify" | "type" = "verify"): string {
  switch (d.value) {
    case "exact":
      return `text\u0000${lineFoldV1(candidate)}`;
    case "edited":
    case "typed":
      return `text\u0000${lineFoldV1(d.text ?? "")}`;
    case "pointed_print":
      if (d.text === null && kind === "type") throw new Error("a typed line's pointed_print must carry its typed letters");
      return `pointed\u0000${lineFoldV1(d.text ?? candidate)}`;
    case "misaligned":
      // A v1.2 misaligned line carries the line as typed: compared as text. Without one (v1, v1.1), the action alone.
      return d.text ? `text\u0000${lineFoldV1(d.text)}` : "misaligned";
    default:
      if (SAME_ACTION.includes(d.value)) return d.value;
      throw new Error(`no agreement value for decision ${JSON.stringify(d.value)}`);
  }
}

export const STEPS = ["pass1", "pass2", "third", "maintainer", "fourth"] as const;
export type Step = (typeof STEPS)[number];
export type Resolution = "agreed" | "majority" | "to_maintainer" | "unresolved" | "pending";
/** Who the line is open to next: anyone, the admin only, any non-admin, or nobody. */
export type OpenTo = "anyone" | "admin" | "non_admin" | "nobody";

export interface CountedVote extends StoredDecision {
  decisionId: string;
  reviewerId: string;
  /** Recorded at decision time; ascending. */
  createdAt: string;
}

export interface LineRouting {
  resolution: Resolution;
  /** The step the next counted decision takes (null when resolved or unresolved). */
  next: Step | null;
  openTo: OpenTo;
  /** When resolved: the value and the two decisions that formed the pair. */
  reference: null | { value: string; pair: [string, string] };
}

/** The reference as exported: { class, text }. */
export function referenceOf(value: string): { class: string; text: string | null } {
  const [cls, text] = value.split("\u0000") as [string, string | undefined];
  return { class: cls, text: text ?? null };
}

/**
 * A line's routing from its counted decisions (in decision order) and whether the admin has any decision on it,
 * counted or not (spec, "Routing"). A pair resolves the line at once; four counted decisions without one leave it
 * unresolved.
 */
export function routeLine(counted: CountedVote[], candidate: string, adminDecided: boolean, kind: "verify" | "type" = "verify"): LineRouting {
  const seen = new Map<string, string>();
  for (let i = 0; i < counted.length; i++) {
    const v = decisionValue(counted[i]!, candidate, kind);
    const first = seen.get(v);
    if (first !== undefined) {
      return { resolution: i === 1 ? "agreed" : "majority", next: null, openTo: "nobody", reference: { value: v, pair: [first, counted[i]!.decisionId] } };
    }
    seen.set(v, counted[i]!.decisionId);
  }
  const n = counted.length;
  if (n === 0) return { resolution: "pending", next: "pass1", openTo: "anyone", reference: null };
  if (n === 1) return { resolution: "pending", next: "pass2", openTo: "anyone", reference: null };
  if (n === 2) return { resolution: "pending", next: "third", openTo: "anyone", reference: null };
  if (n === 3) {
    return adminDecided
      ? { resolution: "pending", next: "fourth", openTo: "non_admin", reference: null }
      : { resolution: "to_maintainer", next: "maintainer", openTo: "admin", reference: null };
  }
  return { resolution: "unresolved", next: null, openTo: "nobody", reference: null };
}
