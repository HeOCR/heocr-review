import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/tasks/import";

const hebrew = /\p{Script=Hebrew}/u;
const latin = /\p{Script=Latin}/u;
const digit = /\p{Nd}/u;
type Span = readonly [number, number];
type Payload = Record<string, unknown>;
export const COMMA_AUDIT = "original_comma_spacing";
export const PUNCTUATION_AUDIT = "original_punctuation_spacing";
const switches = {
  period: ".", semicolon: ";", colon: ":", "question-mark": "?", "exclamation-mark": "!",
} as const;
export type PunctuationMark = (typeof switches)[keyof typeof switches];
type DraftMark = "," | PunctuationMark;

export function punctuationSwitches(flags: Record<string, string | true>): PunctuationMark[] {
  return Object.entries(switches).flatMap(([name, mark]) => {
    if (flags[name] === undefined) return [];
    if (flags[name] !== true) throw new Error(`--${name} does not take a value`);
    return [mark];
  });
}

type Edit = { start: number; end: number; length: number };

const commonLongAbbreviations = new Set(["פרופ", "וכדומ"]);

function hebrewAbbreviation(left: string): boolean {
  const token = left.match(/[\u05d0-\u05ea\p{M}׳״'"]+$/u)?.[0] ?? "";
  const letters = token.replace(/[^\u05d0-\u05ea]/gu, "");
  // Unmarked short Hebrew tokens can be abbreviations or initials. Leave the ambiguous cases in place.
  return letters.length > 0 && (letters.length <= 3 || /[׳״'"]/u.test(token) || commonLongAbbreviations.has(letters));
}

function colonIntroducesList(right: string): boolean {
  const tail = right.replace(/^[\p{Cf}([{"'“‘«]+/u, "");
  if (/^\p{Nd}/u.test(tail)) return true;
  const plain = tail.replace(/\p{M}/gu, "");
  const bullet = /^[•*–—-][^\S\r\n]*[\u05d0-\u05ea]/u;
  const letter = /^[\u05d0-\u05ea]{1,3}(?:[.)\]:־–—-]|[׳'](?:\s|$))/u;
  const ordinal = /^[\u05d0-\u05ea]{1,2}[״"][\u05d0-\u05ea][.)\]:־–—-]/u;
  if (bullet.test(plain) || letter.test(plain) || ordinal.test(plain)) return true;
  // An inline list can also have ordinary Hebrew words for items, separated by a comma or semicolon.
  return /^[\u05d0-\u05ea][^.?!:\r\n]*[,;][^\S\r\n]*[\u05d0-\u05ea]/u.test(plain);
}

function spacing(text: string, marks: readonly DraftMark[]) {
  const edits: Edit[] = [];
  const result = text.replace(/[^\S\r\n]+([,.;:?!])(?=\S|[^\S\r\n]*$)/gmu, (match: string, mark: DraftMark, at: number) => {
    if (!marks.includes(mark)) return match;
    const left = text.slice(0, at);
    const right = text.slice(at + match.length);
    const before = left.match(/[\p{L}\p{M}]+(?=[^\r\n,\p{L}]*$)/u)?.[0] ?? "";
    const after = right.match(/^[^\r\n,\p{L}]*([\p{L}\p{M}]+)/u)?.[1] ?? "";
    if (!hebrew.test(before + after) ||
       (digit.test(Array.from(left).at(-1) ?? "") && digit.test(Array.from(right)[0] ?? ""))) return match;
    if (mark !== "," && latin.test(before + after)) return match;
    if (mark === "." && (/[.…]$/u.test(left) || /^[.…]/u.test(right) || hebrewAbbreviation(left))) return match;
    if (mark === ":" && colonIntroducesList(right)) return match;
    const replacement = /^\S/u.test(right) ? `${mark} ` : mark;
    const start = Array.from(left).length;
    edits.push({ start, end: start + Array.from(match).length, length: replacement.length });
    return replacement;
  });
  return { text: result, edits };
}

export const normalizeDraftCommas = (text: string) => spacing(text, [","]).text;
export const normalizeDraftPunctuation = (text: string, marks: readonly PunctuationMark[] = []) => spacing(text, marks).text;

function remapSpan(span: Span, edits: Edit[]): Span {
  const boundary = (offset: number, right: boolean) => {
    let delta = 0;
    for (const { start, end, length } of edits) {
      if (offset <= start) break;
      if (offset < end) return start + delta + (right ? length : 0);
      delta += length - (end - start);
    }
    return offset + delta;
  };
  const start = boundary(span[0], false);
  return [start, span[0] === span[1] ? start : boundary(span[1], true)];
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Input fields are proposal drafts. Reference text, human answers and ratified gold are excluded. */
export function draftTexts(task: string, payload: Payload): string[] {
  if (payload.gold) return [];
  switch (task) {
    case "line_verify": return typeof payload.candidate_text === "string" ? [payload.candidate_text] : [];
    case "line_consensus": return typeof payload.prefill === "string" ? [payload.prefill] : [];
    case "reference_audit": return typeof payload.proposed === "string" ? [payload.proposed] : [];
    case "page_review": return Array.isArray(payload.lines)
      ? payload.lines.flatMap((line: { text: unknown }) => typeof line.text === "string" ? [line.text] : []) : [];
    default: return [];
  }
}

type AuditEntry = { content_sha256: string; fields: Payload; after_punctuation?: true };
type PunctuationEntry = AuditEntry & { marks: readonly PunctuationMark[] };

/** The content before either cleanup, for matching the original import on a later swap. */
export function originalDraftContent(payload: Payload, hash: string): AuditEntry {
  const punctuation = (payload[PUNCTUATION_AUDIT] as PunctuationEntry[] | undefined)?.[0];
  const comma = payload[COMMA_AUDIT] as AuditEntry | undefined;
  if (comma?.after_punctuation && punctuation) {
    return { content_sha256: punctuation.content_sha256, fields: { ...comma.fields, ...punctuation.fields } };
  }
  return { content_sha256: comma?.content_sha256 ?? punctuation?.content_sha256 ?? hash,
    fields: { ...punctuation?.fields, ...comma?.fields } };
}

function draftSpacingChanges(task: string, payload: Payload, marks: readonly DraftMark[]) {
  if (!draftTexts(task, payload).length) return null;
  let changes: Payload;
  if (task === "page_review") {
    const lines = payload.lines as { text: string }[];
    const corrected = lines.map(line => ({ ...line, text: spacing(line.text, marks).text }));
    if (corrected.every((line, i) => line.text === lines[i]!.text)) return null;
    changes = { lines: corrected, prefill_sha256: digest({ original_prefill_sha256: payload.prefill_sha256, lines: corrected }) };
  } else {
    const field = task === "line_verify" ? "candidate_text" : task === "line_consensus" ? "prefill" : "proposed";
    const original = payload[field] as string;
    const { text, edits } = spacing(original, marks);
    if (text === original) return null;
    changes = { [field]: text };
    if (task === "line_verify" && Array.isArray(payload.attention_spans)) {
      changes.attention_spans = (payload.attention_spans as Span[]).map(span => remapSpan(span, edits));
    }
  }
  const original = Object.fromEntries(Object.keys(changes).filter(key => key in payload).map(key => [key, payload[key]]));
  return { changes, original };
}

/** Keep the deployed comma revision format byte-for-byte compatible. */
export function commaSpacingRevision(task: string, payload: Payload, originalSha: string) {
  if (payload[COMMA_AUDIT]) return null;
  const revised = draftSpacingChanges(task, payload, [","]);
  if (!revised) return null;
  const { changes, original } = revised;
  const audit = { content_sha256: originalSha, fields: original,
    ...(payload[PUNCTUATION_AUDIT] ? { after_punctuation: true as const } : {}) };
  return {
    payload: { ...payload, ...changes, [COMMA_AUDIT]: audit },
    contentSha256: digest({ original_content_sha256: originalSha, rule: "hebrew-comma-spacing-v1", ...changes }),
  };
}

/** Record each opt-in revision independently so a later mark cannot overwrite the preceding audit. */
export function punctuationSpacingRevision(task: string, payload: Payload, currentSha: string, marks: readonly PunctuationMark[]) {
  if (!marks.length) return null;
  const revised = draftSpacingChanges(task, payload, marks);
  if (!revised) return null;
  const { changes, original } = revised;
  const history = (payload[PUNCTUATION_AUDIT] as PunctuationEntry[] | undefined) ?? [];
  const revisedPayload: Payload & { [PUNCTUATION_AUDIT]: PunctuationEntry[] } = {
    ...payload, ...changes, [PUNCTUATION_AUDIT]: [...history, { content_sha256: currentSha, fields: original, marks }],
  };
  return {
    payload: revisedPayload,
    contentSha256: digest({ original_content_sha256: currentSha, rule: "hebrew-punctuation-spacing-v1", ...changes }),
  };
}

export function importSpacingRevision(task: string, payload: Payload, hash: string, marks: readonly PunctuationMark[]) {
  const comma = commaSpacingRevision(task, payload, hash);
  return punctuationSpacingRevision(task, comma?.payload ?? payload, comma?.contentSha256 ?? hash, marks) ?? comma;
}
