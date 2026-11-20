/**
 * The line screen's rules that don't need the DOM, so tests can pin them (design SPEC §4.1, §6, §14.3, §14.4).
 */
import { ApiFailure } from "./api";

/** The design's layout switch: a desktop shows the page beside the line from 900 px. */
export const DESKTOP_QUERY = "(min-width: 900px)";

/**
 * A line the agent pre-check flagged is not marked exact before its full page has been seen (maintainer's decision,
 * 2026-11-19). On a desktop the page is always beside the line with the line boxed, so it counts as seen. On a phone
 * the reviewer has to open it.
 */
export function exactNeedsPage(flagged: boolean, pageOpened: boolean, desktop: boolean): boolean {
  return flagged && !desktop && !pageOpened;
}

/** Why a decision did not save, as the failed notice says it (SPEC §6). */
export type FailureKind = "offline" | "rate_limited" | "daily_limit" | "server" | "rejected";

export function failureKind(err: unknown, online = true): FailureKind {
  if (!(err instanceof ApiFailure)) return online ? "server" : "offline"; // fetch itself failed
  if (err.status === 429) return err.code === "daily_limit" ? "daily_limit" : "rate_limited";
  if (err.status >= 500) return "server";
  return "rejected"; // the server refused this decision (4xx): resending it would not help
}

/** Worth keeping on the device and resending: the decision was fine, the save was not. */
export function keepable(kind: FailureKind): boolean {
  return kind !== "rejected";
}

/** A decision that did not save, kept on this device until it does (SPEC §6, §14.4). */
export interface PendingDecision {
  proposalId: number;
  batchId: string;
  value: string;
  text?: string;
  keptAt: string;
}

type Store = Pick<Storage, "getItem" | "setItem">;
const KEY = "heocr-review.pending.v1";

function local(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readAll(s: Store | null): PendingDecision[] {
  try {
    const raw = s?.getItem(KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((p): p is PendingDecision => typeof p?.proposalId === "number" && typeof p?.value === "string" && typeof p?.batchId === "string") : [];
  } catch {
    return [];
  }
}

function writeAll(list: PendingDecision[], s: Store | null): boolean {
  try {
    if (!s) return false;
    s.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Keep one decision per line (the latest replaces an older one). Returns false when the browser would not keep it. */
export function keepPending(p: PendingDecision, s: Store | null = local()): boolean {
  return writeAll([...readAll(s).filter((x) => x.proposalId !== p.proposalId), p], s);
}

export function pendingFor(batchId: string, s: Store | null = local()): PendingDecision[] {
  return readAll(s).filter((p) => p.batchId === batchId);
}

export function dropPending(proposalId: number, s: Store | null = local()): void {
  const all = readAll(s);
  if (all.some((p) => p.proposalId === proposalId)) writeAll(all.filter((p) => p.proposalId !== proposalId), s);
}

/** Line-edit drafts (SPEC §4.2): the text being typed survives a reload; nothing reaches the server before Save. */
const DRAFT = (id: number) => `heocr-review.draft.${id}`;
function session(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
export function readDraft(id: number, s = session()): string | null {
  try {
    return s?.getItem(DRAFT(id)) ?? null;
  } catch {
    return null;
  }
}
export function writeDraft(id: number, text: string, s = session()): void {
  try {
    s?.setItem(DRAFT(id), text);
  } catch {
    /* the draft is a convenience; the box still works */
  }
}
export function clearDraft(id: number, s = session()): void {
  try {
    s?.removeItem(DRAFT(id));
  } catch {
    /* nothing to clear */
  }
}
