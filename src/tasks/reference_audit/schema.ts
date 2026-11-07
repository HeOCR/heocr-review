/**
 * TypeScript port of hocrgen's reference_audit_proposals.v1 / reference_audit_decisions.v1 validators
 * (hocrgen `src/hocrgen/reference_audit.py`, E2d4, as of branch feat/e2d4-reference-audit commit 0d2af02). Keep this
 * file in step with hocrgen: it is the contract.
 * test/node/reference_audit_schema.test.ts checks it against hocrgen's committed files when they are present.
 */

export const PROPOSALS_SCHEMA = "reference_audit_proposals.v1";
export const DECISIONS_SCHEMA = "reference_audit_decisions.v1";
export const CATEGORIES = [
  "letter_confusion",
  "word_join_split",
  "punctuation",
  "spacing",
  "missing_text",
  "extra_text",
  "unprinted_editors_text",
] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const PAGE_AUDIT_STATUSES = ["audited_with_findings", "audited_no_findings"] as const;
export const DECISION_VALUES = ["accepted", "rejected", "edited"] as const;
export const PROPOSAL_STATUS = "agent_proposed";

/** A decision's reviewer: rv_ and 8 lower-case letters or digits (never a real name). */
export const REVIEWER_ID = /^rv_[0-9a-z]{8}$/;
export const DEFAULT_MIN_REVIEWERS = 1;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface RaProposal {
  proposal_id: string;
  item_id: string;
  start: number;
  end: number;
  current: string;
  proposed: string;
  context_before: string;
  context_after: string;
  category: (typeof CATEGORIES)[number];
  confidence: (typeof CONFIDENCES)[number];
  region: { coordinate_frame: "page"; box_normalized: [number, number, number, number] };
  note: string;
  status: typeof PROPOSAL_STATUS;
  checked_by: "agent";
}

export interface RaPage {
  item_id: string;
  page_title?: string;
  reference_text_revision?: string;
  base_revision_id: number;
  base_text_sha256: string;
  image_sha256?: string;
  audit_status: (typeof PAGE_AUDIT_STATUSES)[number];
  proposal_count: number;
  text_not_on_page_candidate: string | null;
}

export interface RaProposalsFile {
  schema_version: typeof PROPOSALS_SCHEMA;
  audit_id: string;
  description?: string;
  checked_by: "agent";
  checker: string;
  proposed_at: string;
  text_license?: string;
  reference_set?: Record<string, unknown>;
  pages: RaPage[];
  proposals: RaProposal[];
}

export interface RaDecision {
  decision_id: string;
  proposal_id: string;
  item_id?: string;
  decision: (typeof DECISION_VALUES)[number];
  text?: string;
  checked_by: "human";
  reviewer: string;
  decided_at: string;
  note?: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const join = (values: readonly string[]) => values.join(", ");

export function validDate(value: unknown): boolean {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1;
}

function boxProblems(region: unknown): string[] {
  if (!isObj(region) || region.coordinate_frame !== "page") {
    return ["region must be {coordinate_frame: page, box_normalized}"];
  }
  const box = region.box_normalized;
  if (!(Array.isArray(box) && box.length === 4 && box.every(isNum))) {
    return ["region.box_normalized must be [x0, y0, x1, y1]"];
  }
  const [x0, y0, x1, y1] = box as number[] as [number, number, number, number];
  if (!(0 <= x0 && x0 < x1 && x1 <= 1 && 0 <= y0 && y0 < y1 && y1 <= 1)) {
    return ["region.box_normalized must be fractions of the page with x0 < x1 and y0 < y1"];
  }
  return [];
}

export function proposalProblems(p: Obj): string[] {
  const problems: string[] = [];
  for (const key of ["proposal_id", "item_id", "note"]) {
    if (!nonEmpty(p[key])) problems.push(`${key} must be a non-empty string`);
  }
  for (const key of ["current", "proposed", "context_before", "context_after"]) {
    if (typeof p[key] !== "string") problems.push(`${key} must be a string`);
  }
  const { start, end } = p;
  if (!(isInt(start) && isInt(end) && 0 <= start && start <= end)) {
    problems.push("start and end must be character offsets with 0 <= start <= end");
  } else if (typeof p.current === "string" && end - start !== pyLen(p.current)) {
    problems.push("end - start must equal the length of current");
  }
  if (typeof p.current === "string" && p.current === p.proposed) problems.push("proposed must differ from current");
  if (p.current === "" && !(p.context_before && p.context_after)) {
    problems.push("an insertion (empty current) needs both context_before and context_after");
  }
  if (!(CATEGORIES as readonly unknown[]).includes(p.category)) problems.push(`category must be one of ${join(CATEGORIES)}`);
  if (!(CONFIDENCES as readonly unknown[]).includes(p.confidence)) {
    problems.push(`confidence must be one of ${join(CONFIDENCES)}`);
  }
  if (p.status !== PROPOSAL_STATUS) problems.push(`status must be ${PROPOSAL_STATUS}: a proposal is never attestation`);
  if (p.checked_by !== "agent") {
    problems.push("checked_by must be agent: proposals come from the agent audit; humans write decisions");
  }
  problems.push(...boxProblems(p.region));
  return problems;
}

/** Python's len(): code points, not UTF-16 units. hocrgen offsets are code-point offsets. */
export function pyLen(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function overlapProblems(proposals: Obj[]): string[] {
  const ordered = [...proposals].sort((a, b) => (a.start as number) - (b.start as number) || (a.end as number) - (b.end as number));
  const problems: string[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const left = ordered[i]!;
    const right = ordered[i + 1]!;
    const ls = left.start as number;
    const le = left.end as number;
    const rs = right.start as number;
    if (le > rs || (ls === le && le === rs)) problems.push(`${String(left.proposal_id)} and ${String(right.proposal_id)} overlap`);
  }
  return problems;
}

/** Every problem with a reference_audit_proposals.v1 payload (empty when valid). */
export function proposalsFileProblems(payload: unknown): string[] {
  if (!isObj(payload) || payload.schema_version !== PROPOSALS_SCHEMA) return [`schema_version must be ${PROPOSALS_SCHEMA}`];
  const problems: string[] = [];
  if (!nonEmpty(payload.audit_id)) problems.push("audit_id must be a non-empty string");
  if (payload.checked_by !== "agent") problems.push("checked_by must be agent");
  if (!nonEmpty(payload.checker)) problems.push("checker must name the agent");
  if (!validDate(payload.proposed_at)) problems.push("proposed_at must be a YYYY-MM-DD date");
  const pages = new Map<string, Obj>();
  for (const page of Array.isArray(payload.pages) ? payload.pages : []) {
    const itemId = isObj(page) ? page.item_id : undefined;
    if (!isObj(page) || typeof itemId !== "string" || pages.has(itemId)) {
      problems.push(`page ${JSON.stringify(itemId ?? null)}: item_id missing or listed twice`);
      continue;
    }
    pages.set(itemId, page);
    if (!isInt(page.base_revision_id)) problems.push(`page ${itemId}: base_revision_id must be the revision the text comes from`);
    if (!(typeof page.base_text_sha256 === "string" && SHA256.test(page.base_text_sha256))) {
      problems.push(`page ${itemId}: base_text_sha256 must be a SHA-256`);
    }
    if (!(PAGE_AUDIT_STATUSES as readonly unknown[]).includes(page.audit_status)) {
      problems.push(`page ${itemId}: audit_status must be one of ${join(PAGE_AUDIT_STATUSES)}`);
    }
    const candidate = page.text_not_on_page_candidate;
    if (candidate !== null && candidate !== undefined && !nonEmpty(candidate)) {
      problems.push(`page ${itemId}: text_not_on_page_candidate must be null or say what is not on the page`);
    }
  }
  if (pages.size === 0) problems.push("pages must list every audited page");
  const byPage = new Map<string, Obj[]>();
  const ids = new Set<unknown>();
  for (const proposal of Array.isArray(payload.proposals) ? payload.proposals : []) {
    if (!isObj(proposal)) {
      problems.push("proposal must be an object");
      continue;
    }
    const pid = proposal.proposal_id;
    problems.push(...proposalProblems(proposal).map((x) => `proposal ${String(pid)}: ${x}`));
    if (ids.has(pid)) problems.push(`proposal ${String(pid)}: listed twice`);
    ids.add(pid);
    if (typeof proposal.item_id !== "string" || !pages.has(proposal.item_id)) {
      problems.push(`proposal ${String(pid)}: item_id is not an audited page`);
      continue;
    }
    const list = byPage.get(proposal.item_id) ?? [];
    list.push(proposal);
    byPage.set(proposal.item_id, list);
  }
  if (problems.length) return problems;
  for (const [itemId, page] of pages) {
    const found = byPage.get(itemId) ?? [];
    if (page.proposal_count !== found.length) {
      problems.push(`page ${itemId}: proposal_count ${String(page.proposal_count)} but ${found.length} proposals`);
    }
    if (page.audit_status === "audited_no_findings" && found.length) problems.push(`page ${itemId}: audited_no_findings but has proposals`);
    if (page.audit_status === "audited_with_findings" && !found.length) {
      problems.push(`page ${itemId}: audited_with_findings but has no proposals`);
    }
    problems.push(...overlapProblems(found));
  }
  return problems;
}

export function reviewerIdProblems(reviewer: unknown): string[] {
  if (!(typeof reviewer === "string" && REVIEWER_ID.test(reviewer))) {
    return ["reviewer must be a pseudonymous id: rv_ and 8 lower-case letters or digits (e.g. rv_3f9a01bc)"];
  }
  return [];
}

/** hocrgen's decision_id convention: one decision per reviewer per proposal. */
export function decisionId(proposalId: string, reviewer: string): string {
  return `decision:${proposalId}:${reviewer}`;
}

export interface ProposalRef {
  proposal_id: string;
  item_id: string;
  current: string;
}

/** Every problem with a reference_audit_decisions.v1 payload, checked against its proposals. Several reviewers may
 * decide one proposal, one decision each. */
export function decisionsFileProblems(payload: unknown, auditId: string, proposals: ProposalRef[]): string[] {
  if (!isObj(payload) || payload.schema_version !== DECISIONS_SCHEMA) return [`schema_version must be ${DECISIONS_SCHEMA}`];
  const problems: string[] = [];
  if (payload.audit_id !== auditId) problems.push("audit_id must match the proposals' audit_id");
  const known = new Map(proposals.map((p) => [p.proposal_id, p]));
  const decided = new Set<string>(); // "<proposal_id>\u0000<reviewer>"
  const ids = new Set<unknown>();
  if (!Array.isArray(payload.decisions)) return [...problems, "decisions must be a list"];
  payload.decisions.forEach((raw, index) => {
    const decision: Obj = isObj(raw) ? raw : {};
    const did = decision.decision_id;
    const label = `decision ${nonEmpty(did) ? did : index + 1}`;
    if (!nonEmpty(did)) problems.push(`${label}: decision_id must be a non-empty string`);
    else if (ids.has(did)) problems.push(`${label}: decision_id listed twice`);
    ids.add(did);
    const pid = decision.proposal_id;
    const proposal = typeof pid === "string" ? known.get(pid) : undefined;
    if (!proposal) problems.push(`${label}: proposal_id ${JSON.stringify(pid ?? null)} is not a proposal of ${auditId}`);
    else if (decided.has(`${proposal.proposal_id}\u0000${String(decision.reviewer)}`)) {
      problems.push(`${label}: a second decision by ${String(decision.reviewer)} for ${proposal.proposal_id}; one per reviewer`);
    } else {
      decided.add(`${proposal.proposal_id}\u0000${String(decision.reviewer)}`);
      if (decision.item_id !== undefined && decision.item_id !== null && decision.item_id !== proposal.item_id) {
        problems.push(`${label}: item_id does not match the proposal's`);
      }
    }
    const value = decision.decision;
    if (!(DECISION_VALUES as readonly unknown[]).includes(value)) problems.push(`${label}: decision must be one of ${join(DECISION_VALUES)}`);
    if (value === "edited") {
      if (typeof decision.text !== "string") problems.push(`${label}: an edited decision needs the reviewer's text for the span`);
      else if (proposal && decision.text === proposal.current) {
        problems.push(`${label}: an edit equal to the current text is a rejection; record rejected`);
      }
    } else if ("text" in decision) problems.push(`${label}: only an edited decision carries text`);
    if (decision.checked_by !== "human") problems.push(`${label}: checked_by must be human; an agent proposal is never a decision`);
    problems.push(...reviewerIdProblems(decision.reviewer).map((x) => `${label}: ${x}`));
    if (!validDate(decision.decided_at)) problems.push(`${label}: decided_at must be a YYYY-MM-DD date`);
    if (decision.note !== undefined && decision.note !== null && typeof decision.note !== "string") {
      problems.push(`${label}: note must be a string`);
    }
  });
  return problems;
}
