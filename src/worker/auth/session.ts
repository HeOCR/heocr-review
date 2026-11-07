/**
 * The app's own session: a signed, HttpOnly cookie holding the reviewer pseudonym and an expiry.
 * Format: v1.<reviewerId>.<expUnix>.<base64url HMAC-SHA256(SESSION_SECRET)>.
 */
import { base64url, base64urlDecode, hmacSha256, hmacVerify, requireSecret } from "../crypto";
import type { Env } from "../env";

export const SESSION_COOKIE = "__Host-hr_session";
export const SESSION_TTL_S = 14 * 24 * 3600;
const REVIEWER_ID = /^rv_[0-9a-f]{8}$/;

export async function createSessionCookie(env: Env, reviewerId: string, nowMs = Date.now()): Promise<string> {
  const secret = requireSecret(env.SESSION_SECRET, "SESSION_SECRET");
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_S;
  const body = `v1.${reviewerId}.${exp}`;
  const sig = base64url(await hmacSha256(secret, body));
  return `${SESSION_COOKIE}=${body}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** The reviewer id of a valid, unexpired session cookie, or null. */
export async function readSession(env: Env, request: Request, nowMs = Date.now()): Promise<string | null> {
  const value = cookieValue(request, SESSION_COOKIE);
  if (!value || value.length > 200) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, reviewerId, exp, sig] = parts as [string, string, string, string];
  if (!REVIEWER_ID.test(reviewerId) || !/^\d{1,12}$/.test(exp)) return null;
  if (Number(exp) * 1000 < nowMs) return null;
  let signature: Uint8Array;
  try {
    signature = base64urlDecode(sig);
  } catch {
    return null;
  }
  const secret = requireSecret(env.SESSION_SECRET, "SESSION_SECRET");
  return (await hmacVerify(secret, `v1.${reviewerId}.${exp}`, signature)) ? reviewerId : null;
}
