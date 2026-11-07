/**
 * Sign in with Google (Google Identity Services, ID-token flow). The browser gets an ID token for our client id;
 * the Worker verifies its RS256 signature against Google's JWKS and checks iss, aud, exp and iat. No client secret.
 * Only `sub` is used. Email and name claims are never read or stored.
 */
import type { Env } from "../env";
import { base64urlDecode } from "../crypto";
import { HttpError } from "../http";
import type { IdentityProvider } from "./provider";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_LENGTH = 4096;

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

type JwksFetcher = () => Promise<{ keys: Jwk[]; maxAgeS: number }>;

let cache: { keys: Map<string, Jwk>; expires: number } | null = null;

async function defaultFetchJwks(): Promise<{ keys: Jwk[]; maxAgeS: number }> {
  const res = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  return { keys: body.keys ?? [], maxAgeS: maxAge ? Number(maxAge[1]) : 3600 };
}

let fetchJwks: JwksFetcher = defaultFetchJwks;

/** Tests only: replace the JWKS source. */
export function setJwksFetcherForTests(fetcher: JwksFetcher | null): void {
  fetchJwks = fetcher ?? defaultFetchJwks;
  cache = null;
}

async function keyFor(kid: string, nowMs: number): Promise<Jwk | undefined> {
  if (!cache || cache.expires < nowMs || !cache.keys.has(kid)) {
    // Refetch on expiry or an unknown kid (Google rotates keys).
    const { keys, maxAgeS } = await fetchJwks();
    cache = { keys: new Map(keys.map((k) => [k.kid, k])), expires: nowMs + Math.min(Math.max(maxAgeS, 60), 86400) * 1000 };
  }
  return cache.keys.get(kid);
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64urlDecode(part)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

export interface VerifiedGoogleToken {
  sub: string;
}

export async function verifyGoogleIdToken(token: string, clientId: string, nowMs = Date.now()): Promise<VerifiedGoogleToken> {
  const fail = (why: string): never => {
    throw new HttpError(401, "invalid_credential", why);
  };
  if (!clientId) throw new HttpError(503, "google_not_configured");
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) fail("malformed token");
  const parts = token.split(".");
  if (parts.length !== 3) fail("malformed token");
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = decodeJson(h);
    claims = decodeJson(p);
    signature = base64urlDecode(s);
  } catch {
    return fail("malformed token");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") fail("unexpected algorithm");
  const jwk = await keyFor(header.kid as string, nowMs);
  if (!jwk || jwk.kty !== "RSA") fail("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk!.n, e: jwk!.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) fail("bad signature");
  const now = Math.floor(nowMs / 1000);
  if (!GOOGLE_ISSUERS.includes(claims.iss as string)) fail("bad issuer");
  const aud = claims.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.length === 1 && aud[0] === clientId))) fail("bad audience");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) fail("expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now) fail("issued in the future");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) fail("no subject");
  return { sub: claims.sub as string };
}

export const googleProvider: IdentityProvider = {
  id: "google",
  enabled: (env: Env) => Boolean(env.GOOGLE_CLIENT_ID),
  async authenticate(body, env) {
    const credential = body.credential;
    if (typeof credential !== "string") throw new HttpError(400, "credential_required");
    const { sub } = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID ?? "");
    return { subject: sub };
  },
};
