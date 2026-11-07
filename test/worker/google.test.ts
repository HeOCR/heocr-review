import { afterEach, describe, expect, it } from "vitest";
import { setJwksFetcherForTests, verifyGoogleIdToken } from "../../src/worker/auth/google";
import { base64url } from "../../src/worker/crypto";

const CLIENT = "test-client.apps.googleusercontent.com";
const enc = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));

async function keypair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { pair, jwk: { kid, kty: "RSA", alg: "RS256", n: jwk.n!, e: jwk.e! } };
}

async function sign(key: CryptoKey, kid: string, claims: Record<string, unknown>) {
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(sig)}`;
}

const now = Date.UTC(2026, 10, 7, 12, 0, 0);
const t = Math.floor(now / 1000);
const good = { iss: "https://accounts.google.com", aud: CLIENT, sub: "1234567890", iat: t - 10, exp: t + 3000, email: "x@example.com" };

describe("Google ID token verification", () => {
  afterEach(() => setJwksFetcherForTests(null));

  it("accepts a valid token and returns only the subject", async () => {
    const { pair, jwk } = await keypair("k1");
    setJwksFetcherForTests(async () => ({ keys: [jwk], maxAgeS: 3600 }));
    const out = await verifyGoogleIdToken(await sign(pair.privateKey, "k1", good), CLIENT, now);
    expect(out).toEqual({ sub: "1234567890" });
  });

  it.each([
    ["wrong audience", { aud: "other-client" }],
    ["wrong issuer", { iss: "https://evil.example" }],
    ["expired", { exp: t - 3600 }],
    ["issued in the future", { iat: t + 3600 }],
    ["no subject", { sub: "" }],
  ])("rejects %s", async (_, patch) => {
    const { pair, jwk } = await keypair("k1");
    setJwksFetcherForTests(async () => ({ keys: [jwk], maxAgeS: 3600 }));
    await expect(verifyGoogleIdToken(await sign(pair.privateKey, "k1", { ...good, ...patch }), CLIENT, now)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a token signed by another key and refetches keys for an unknown kid", async () => {
    const a = await keypair("ka");
    const b = await keypair("kb");
    let fetches = 0;
    setJwksFetcherForTests(async () => {
      fetches++;
      return { keys: [a.jwk], maxAgeS: 3600 };
    });
    const forged = await sign(b.pair.privateKey, "ka", good);
    await expect(verifyGoogleIdToken(forged, CLIENT, now)).rejects.toMatchObject({ status: 401 });
    await expect(verifyGoogleIdToken(await sign(b.pair.privateKey, "kb", good), CLIENT, now)).rejects.toMatchObject({ status: 401 });
    expect(fetches).toBe(2);
  });

  it("rejects alg=none and malformed tokens", async () => {
    setJwksFetcherForTests(async () => ({ keys: [], maxAgeS: 3600 }));
    const none = `${enc({ alg: "none", kid: "k1" })}.${enc(good)}.`;
    await expect(verifyGoogleIdToken(none, CLIENT, now)).rejects.toMatchObject({ status: 401 });
    await expect(verifyGoogleIdToken("abc", CLIENT, now)).rejects.toMatchObject({ status: 401 });
  });
});
