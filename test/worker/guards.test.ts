import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handle } from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { Client } from "./helpers";

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

  it("rate-limits decisions per reviewer", async () => {
    const c = new Client();
    await c.signIn("fast");
    await c.acceptTerms();
    const id = (await env.DB.prepare("SELECT id FROM proposals ORDER BY rank LIMIT 1").first<{ id: number }>())!.id;
    let limited = 0;
    for (let i = 0; i < 65; i++) {
      const res = await c.req("POST", `/api/proposals/${id}/decision`, { value: i % 2 ? "accepted" : "rejected" });
      if (res.status === 429) {
        limited++;
        expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      }
    }
    expect(limited).toBeGreaterThan(0);
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
