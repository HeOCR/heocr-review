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
  writeDay: { bucket: "write-d", max: 3000, windowS: 86400 },
  /** Reads per reviewer. */
  readMinute: { bucket: "read-m", max: 300, windowS: 60 },
  /** Sign-in attempts per client address (stored only as a keyed hash). */
  signInMinute: { bucket: "signin-m", max: 20, windowS: 60 },
  /** Profile and consent changes per reviewer. */
  profileHour: { bucket: "profile-h", max: 30, windowS: 3600 },
} satisfies Record<string, Limit>;

/** Fixed-window counter in D1. Throws 429 when `subject` is over `limit`. */
export async function enforce(db: D1Database, limit: Limit, subject: string, nowMs = Date.now()): Promise<void> {
  const windowStart = Math.floor(nowMs / 1000 / limit.windowS) * limit.windowS;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(`${limit.bucket}:${subject}`, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit.max) {
    const retry = windowStart + limit.windowS - Math.floor(nowMs / 1000);
    throw new HttpError(429, "rate_limited", "too many requests", { "retry-after": String(Math.max(1, retry)) });
  }
}

/** A keyed hash of the client address, so raw addresses never reach the database. */
export async function clientKey(env: Env, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return hex(await hmacSha256(env.SESSION_SECRET ?? "unset", `ip:${ip}`)).slice(0, 16);
}

/** Drop windows older than two days (called opportunistically). */
export async function pruneRateLimits(db: D1Database, nowMs = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(Math.floor(nowMs / 1000) - 2 * 86400).run();
}
