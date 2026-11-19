import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { LIMITS, enforce, resetRateLimits } from "../../src/worker/ratelimit";
import { BATCH, Client } from "./helpers";

const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function call(e: Env, url: string, init: RequestInit = {}) {
  return handle(new Request(url, init), e, exec);
}

const devSignIn = (origin: string): RequestInit => ({
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ subject: "x" }),
});

describe("dev sign-in cannot be enabled outside local development", () => {
  it("is off on a workers.dev host even with the flag", async () => {
    const res = await call(env, "https://heocr-review.example.workers.dev/api/auth/dev", devSignIn("https://heocr-review.example.workers.dev"));
    expect(res.status).toBe(404);
  });

  it("is off when ENVIRONMENT is preview or production, even on localhost", async () => {
    for (const ENVIRONMENT of ["preview", "production"]) {
      const res = await call({ ...env, ENVIRONMENT }, "http://localhost/api/auth/dev", devSignIn("http://localhost"));
      expect(res.status).toBe(404);
      const cfg = (await (await call({ ...env, ENVIRONMENT }, "http://localhost/api/config")).json()) as { devAuth: boolean };
      expect(cfg.devAuth).toBe(false);
    }
  });

  it("is off without the flag", async () => {
    const res = await call({ ...env, DEV_AUTH_BYPASS: undefined }, "http://localhost/api/auth/dev", devSignIn("http://localhost"));
    expect(res.status).toBe(404);
  });
});

describe("request guards", () => {
  it("refuses cross-origin and origin-less writes", async () => {
    const c = new Client();
    await c.signIn("guard");
    const evil = await c.req("POST", "/api/me/terms", { accept: true }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const res = await call(env, "http://localhost/api/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  it("refuses non-JSON bodies", async () => {
    const res = await call(env, "http://localhost/api/auth/dev", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "text/plain" },
      body: "subject=x",
    });
    expect(res.status).toBe(415);
  });

  it("ignores a tampered session cookie", async () => {
    const c = new Client();
    await c.signIn("tamper");
    const [name, value] = c.cookie.split("=") as [string, string];
    const parts = value.split(".");
    parts[1] = "rv_00000000";
    c.cookie = `${name}=${parts.join(".")}`;
    expect((await c.get("/api/me")).status).toBe(401);
  });

  it("refuses to run without its secrets", async () => {
    const res = await call({ ...env, SESSION_SECRET: undefined }, "http://localhost/api/auth/dev", devSignIn("http://localhost"));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("server_misconfigured");
  });

  // The limiter writes nothing to D1 (src/worker/ratelimit.ts): per-minute limits are counters in this isolate's
  // memory, the day and profile limits are counted from the tables. None of these tests depends on where the clock
  // falls in a window: the API test fills the reviewer's counter for the window it will run in, and retries once if
  // the request lands in the next one.
  it("rate-limits decisions per reviewer", async () => {
    const c = new Client();
    const reviewerId = await c.signIn("fast");
    await c.acceptTerms();
    const id = (await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 ORDER BY rank LIMIT 1").bind(BATCH).first<{ id: number }>())!.id;
    const { max, windowS } = LIMITS.writeMinute;
    const windowOf = (ms: number) => Math.floor(ms / 1000 / windowS);
    for (let attempt = 0; attempt < 2; attempt++) {
      resetRateLimits();
      const before = Date.now();
      for (let i = 0; i < max; i++) enforce(LIMITS.writeMinute, reviewerId, before);
      const res = await c.req("POST", `/api/proposals/${id}/decision`, { value: "accepted" });
      if (windowOf(Date.now()) !== windowOf(before)) continue; // crossed into a new window: try again
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      return;
    }
    throw new Error("two window crossings in a row");
  });

  it("counts a window up to its limit, then refuses until the next window, in memory", () => {
    const limit = LIMITS.writeMinute;
    const t0 = 1_800_000_000_000; // a fixed instant, at the start of a window
    for (let i = 0; i < limit.max; i++) enforce(limit, "rv_counting", t0 + i);
    expect(() => enforce(limit, "rv_counting", t0 + 30_000)).toThrow(expect.objectContaining({ status: 429 }));
    expect(() => enforce(limit, "rv_counting", t0 + limit.windowS * 1000)).not.toThrow();
  });

  it("limits decisions per UTC day from the decisions themselves", async () => {
    const c = new Client();
    const reviewerId = await c.signIn("busy");
    await c.acceptTerms();
    const id = (await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 ORDER BY rank LIMIT 1").bind(BATCH).first<{ id: number }>())!.id;
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?3)
       INSERT INTO decisions (id, proposal_id, reviewer_id, value, text, proposal_sha256, terms_version, created_at, decided_on, superseded_at)
       SELECT 'day-' || i, ?1, ?2, 'accepted', NULL, 'x', 'x', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), date('now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n`,
    ).bind(id, reviewerId, LIMITS.writeDay.max).run();
    const res = await c.req("POST", `/api/proposals/${id}/decision`, { value: "accepted" });
    expect(res.status).toBe(429);
  });

  it("limits profile changes per hour from the consent log", async () => {
    const c = new Client();
    const reviewerId = await c.signIn("chatty");
    await c.acceptTerms();
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO consent_events (reviewer_id, kind, terms_version, value, created_at)
       SELECT ?1, 'display_name_withdrawn', 'x', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n`,
    ).bind(reviewerId, LIMITS.profileHour.max).run();
    const res = await c.req("POST", "/api/me/terms", { termsVersion: "x", accept: true, displayName: null });
    expect(res.status).toBe(429);
  });

  it("writes no rate-limit rows: reads and decisions leave rate_limits empty", async () => {
    const c = new Client();
    await c.signIn("quiet");
    await c.acceptTerms();
    for (let i = 0; i < 5; i++) await c.get("/api/batches");
    const id = (await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 ORDER BY rank LIMIT 1").bind(BATCH).first<{ id: number }>())!.id;
    await c.req("POST", `/api/proposals/${id}/decision`, { value: "accepted" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())!.n).toBe(0);
  });

  it("blocks a blocked reviewer", async () => {
    const c = new Client();
    const id = await c.signIn("blocked");
    await env.DB.prepare("UPDATE reviewers SET blocked = 1 WHERE id = ?1").bind(id).run();
    expect((await c.get("/api/me")).status).toBe(403);
  });

  it("does not expose API errors as HTML and never caches API responses", async () => {
    const res = await call(env, "http://localhost/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("the app works on each of its hosts", () => {
  const hosts = ["https://review.heocr.org", "https://heocr-review.heocr.workers.dev"];
  const logout = (origin: string): RequestInit => ({ method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" });

  it("accepts a same-origin write on either host, with a host-only cookie", async () => {
    for (const host of hosts) {
      const res = await call(env, `${host}/api/auth/logout`, logout(host));
      expect(res.status).toBe(200);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie.toLowerCase()).not.toContain("domain=");
    }
  });

  it("rejects a write whose Origin is the other host", async () => {
    const res = await call(env, `${hosts[0]}/api/auth/logout`, logout(hosts[1]!));
    expect(res.status).toBe(403);
  });
});
