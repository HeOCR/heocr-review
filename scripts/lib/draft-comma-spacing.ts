import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/tasks/import";

const hebrew = /\p{Script=Hebrew}/u;
const digit = /\p{Nd}/u;
type Span = readonly [number, number];
type Payload = Record<string, unknown>;
export const COMMA_AUDIT = "original_comma_spacing";

type Edit = { start: number; end: number; length: number };

function spacing(text: string) {
  const edits: Edit[] = [];
  const result = text.replace(/[^\S\r\n]+,(?=\S|[^\S\r\n]*$)/gmu, (match: string, at: number) => {
    const left = text.slice(0, at);
    const right = text.slice(at + match.length);
    const before = left.match(/[\p{L}\p{M}]+(?=[^\r\n,\p{L}]*$)/u)?.[0] ?? "";
    const after = right.match(/^[^\r\n,\p{L}]*([\p{L}\p{M}]+)/u)?.[1] ?? "";
    if (!hebrew.test(before + after) ||
       (digit.test(Array.from(left).at(-1) ?? "") && digit.test(Array.from(right)[0] ?? ""))) return match;
    const replacement = /^\S/u.test(right) ? ", " : ",";
    const start = Array.from(left).length;
    edits.push({ start, end: start + Array.from(match).length, length: replacement.length });
    return replacement;
  });
  return { text: result, edits };
}

export const normalizeDraftCommas = (text: string) => spacing(text).text;

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

/** Use the same revision convention for a new import and a live, formerly uncorrected proposal. */
export function commaSpacingRevision(task: string, payload: Payload, originalSha: string) {
  if (payload[COMMA_AUDIT] || !draftTexts(task, payload).length) return null;
  let changes: Payload;
  if (task === "page_review") {
    const lines = payload.lines as { text: string }[];
    const corrected = lines.map(line => ({ ...line, text: normalizeDraftCommas(line.text) }));
    if (corrected.every((line, i) => line.text === lines[i]!.text)) return null;
    changes = { lines: corrected, prefill_sha256: digest({ original_prefill_sha256: payload.prefill_sha256, lines: corrected }) };
  } else {
    const field = task === "line_verify" ? "candidate_text" : task === "line_consensus" ? "prefill" : "proposed";
    const original = payload[field] as string;
    const { text, edits } = spacing(original);
    if (text === original) return null;
    changes = { [field]: text };
    if (task === "line_verify" && Array.isArray(payload.attention_spans)) {
      changes.attention_spans = (payload.attention_spans as Span[]).map(span => remapSpan(span, edits));
    }
  }
  const original = Object.fromEntries(Object.keys(changes).filter(key => key in payload).map(key => [key, payload[key]]));
  const audit = { content_sha256: originalSha, fields: original };
  return {
    payload: { ...payload, ...changes, [COMMA_AUDIT]: audit },
    contentSha256: digest({ original_content_sha256: originalSha, rule: "hebrew-comma-spacing-v1", ...changes }),
  };
}
