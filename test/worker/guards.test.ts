import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { LIMITS, enforce } from "../../src/worker/ratelimit";
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

  // The limiter counts in fixed windows, so these tests never depend on where the wall clock falls in a window:
  // the API test fills the reviewer's counter for the current and the next window, and the counting test passes
  // a fixed time.
  it("rate-limits decisions per reviewer", async () => {
    const c = new Client();
    const reviewerId = await c.signIn("fast");
    await c.acceptTerms();
    const id = (await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 ORDER BY rank LIMIT 1").bind(BATCH).first<{ id: number }>())!.id;
    const { bucket, max, windowS } = LIMITS.writeMinute;
    const now = Math.floor(Date.now() / 1000 / windowS) * windowS;
    for (const start of [now, now + windowS]) {
      await env.DB.prepare("INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)").bind(`${bucket}:${reviewerId}`, start, max).run();
    }
    const res = await c.req("POST", `/api/proposals/${id}/decision`, { value: "accepted" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("counts a window up to its limit, then refuses until the next window", async () => {
    const limit = LIMITS.writeMinute;
    const t0 = 1_800_000_000_000; // a fixed instant, at the start of a window
    for (let i = 0; i < limit.max; i++) await enforce(env.DB, limit, "rv_counting", t0 + i);
    await expect(enforce(env.DB, limit, "rv_counting", t0 + 30_000)).rejects.toMatchObject({ status: 429 });
    await expect(enforce(env.DB, limit, "rv_counting", t0 + limit.windowS * 1000)).resolves.toBeUndefined();
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
