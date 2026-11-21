/**
 * Request rate limits, with no D1 write per request (2026-11-19). The old limiter upserted a counter row in D1 on
 * every request, reads included; on the free plan's shared daily budget of row writes (preview and production) that
 * took production down. Now:
 *
 * - per-minute limits (and the draft day limit) are fixed-window counters in this Worker isolate's memory:
 *   best-effort (each isolate counts on its own and restarts reset them), which is enough against a runaway client;
 * - the daily decision limit is counted from the decisions and skips themselves, and the hourly profile limit from
 *   consent_events: reads, not writes, and exact across isolates.
 *
 * The rate_limits table (migrations/0001) is no longer written.
 */
import { hex, hmacSha256 } from "./crypto";
import type { Env } from "./env";
import { HttpError } from "./http";

export interface Limit {
  bucket: string;
  max: number;
  windowS: number;
}

export const LIMITS = {
  /** Decisions and skips per reviewer. */
  writeMinute: { bucket: "write-m", max: 60, windowS: 60 },
  /** Three requests per pair in an admin-only realism session of up to 50 pairs. */
  realismMinute: { bucket: "realism-m", max: 180, windowS: 60 },
  rankingReadMinute: { bucket: "ranking-read-m", max: 480, windowS: 60 },
  writeDay: { bucket: "write-d", max: 3000, windowS: 86400 },
  /** Draft saves per reviewer (page_review autosave, debounced in the browser): their own bucket, not decisions'. */
  draftMinute: { bucket: "draft-m", max: 120, windowS: 60 },
  draftDay: { bucket: "draft-d", max: 20000, windowS: 86400 },
  /** Reads per reviewer. */
  readMinute: { bucket: "read-m", max: 300, windowS: 60 },
  /** Sign-in attempts per client address (a keyed hash, never the address). */
  signInMinute: { bucket: "signin-m", max: 20, windowS: 60 },
  /** Profile and consent changes per reviewer. */
  profileHour: { bucket: "profile-h", max: 30, windowS: 3600 },
} satisfies Record<string, Limit>;

const windows = new Map<string, { start: number; count: number }>();
/** Above this many keys, windows that have ended are dropped. */
const PRUNE_AT = 10_000;

/** Tests: start from no counts. */
export function resetRateLimits(): void {
  windows.clear();
}

function refuse(retryS: number, code: "rate_limited" | "daily_limit" = "rate_limited"): never {
  throw new HttpError(429, code, code === "daily_limit" ? "daily limit reached" : "too many requests", { "retry-after": String(Math.max(1, Math.ceil(retryS))) });
}

/** Seconds from `nowMs` to the next 00:00 UTC, when daily limits reset. */
export function secondsToUtcMidnight(nowMs = Date.now()): number {
  return Math.max(1, Math.ceil((Math.floor(nowMs / 86_400_000) * 86_400_000 + 86_400_000 - nowMs) / 1000));
}

/**
 * Cloudflare's own D1 quota (the account's daily rows read or written; it took production down on 2026-11-19). The
 * request can't be served, but nothing is wrong with it: the client says so (daily_limit) rather than a bare 500.
 */
export function isD1QuotaError(message: string): boolean {
  return /D1_ERROR/.test(message) && /(daily row (?:read|write) limit|exceeded D1's free tier|limit exceeded)/i.test(message);
}

/** In-memory fixed-window counter (this isolate). Throws 429 when `subject` is over `limit`. Writes nothing to D1. */
export function enforce(limit: Limit, subject: string, nowMs = Date.now()): void {
  const start = Math.floor(nowMs / 1000 / limit.windowS) * limit.windowS;
  const key = `${limit.bucket}:${subject}`;
  const w = windows.get(key);
  const count = w && w.start === start ? w.count + 1 : 1;
  windows.set(key, { start, count });
  if (windows.size > PRUNE_AT) {
    const nowS = Math.floor(nowMs / 1000);
    for (const [k, v] of windows) if (v.start + 86400 < nowS) windows.delete(k);
  }
  if (count > limit.max) refuse(start + limit.windowS - nowMs / 1000);
}

const dayStartIso = (nowMs: number) => new Date(Math.floor(nowMs / 86_400_000) * 86_400_000).toISOString();

/** The daily decision limit, from the reviewer's decisions and skips since 00:00 UTC (a read, exact). */
export async function enforceWriteDay(db: D1Database, reviewerId: string, nowMs = Date.now()): Promise<void> {
  const since = dayStartIso(nowMs);
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM decisions WHERE reviewer_id = ?1 AND created_at >= ?2)
            + (SELECT COUNT(*) FROM skips WHERE reviewer_id = ?1 AND created_at >= ?2) AS n`,
    )
    .bind(reviewerId, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= LIMITS.writeDay.max) refuse((Date.parse(since) + 86_400_000 - nowMs) / 1000, "daily_limit");
}

/** The hourly profile limit, from the reviewer's consent log in the last hour (a read, exact). */
export async function enforceProfileHour(db: D1Database, reviewerId: string, nowMs = Date.now()): Promise<void> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM consent_events WHERE reviewer_id = ?1 AND created_at >= ?2")
    .bind(reviewerId, new Date(nowMs - 3_600_000).toISOString())
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= LIMITS.profileHour.max) refuse(60);
}

/** A keyed hash of the client address, so raw addresses are never kept. */
export async function clientKey(env: Env, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return hex(await hmacSha256(env.SESSION_SECRET ?? "unset", `ip:${ip}`)).slice(0, 16);
}
