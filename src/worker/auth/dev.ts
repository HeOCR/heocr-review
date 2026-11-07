/**
 * Dev-only sign-in for local development and tests. It cannot be enabled on a deployed Worker: it needs all of
 *   - ENVIRONMENT === "development" (wrangler.jsonc sets "production" and "preview"; only .dev.vars says
 *     "development", and wrangler never uploads .dev.vars),
 *   - DEV_AUTH_BYPASS === "1" (.dev.vars only; test/worker/guards.test.ts refuses it in wrangler.jsonc), and
 *   - a loopback request host (a Worker on workers.dev or a custom domain never sees one).
 */
import type { Env } from "../env";
import { HttpError } from "../http";
import type { IdentityProvider } from "./provider";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function devAuthEnabled(env: Env, request: Request): boolean {
  return env.ENVIRONMENT === "development" && env.DEV_AUTH_BYPASS === "1" && LOOPBACK.has(new URL(request.url).hostname);
}

export const devProvider: IdentityProvider = {
  id: "dev",
  enabled: devAuthEnabled,
  async authenticate(body) {
    const subject = body.subject;
    if (typeof subject !== "string" || !/^[a-z0-9-]{1,40}$/.test(subject)) throw new HttpError(400, "subject_required");
    return { subject };
  },
};
