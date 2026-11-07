import * as api from "./api";
import type { Ctx } from "./api";
import type { Env } from "./env";
import { HttpError, errorResponse, json } from "./http";

type Handler = (ctx: Ctx, ...params: string[]) => Promise<Response>;

const int = (s: string) => (/^\d{1,15}$/.test(s) ? Number(s) : NaN);

const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/config$/, (c) => api.config(c)],
  ["POST", /^\/api\/auth\/logout$/, (c) => api.signOut(c)],
  ["POST", /^\/api\/auth\/([a-z]+)$/, (c, p) => api.signIn(c, p!)],
  ["GET", /^\/api\/me$/, (c) => api.getMe(c)],
  ["POST", /^\/api\/me\/terms$/, (c) => api.acceptTerms(c)],
  ["POST", /^\/api\/me\/display-name$/, (c) => api.setDisplayName(c)],
  ["GET", /^\/api\/batches$/, (c) => api.batches(c)],
  ["GET", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/next$/, (c, b) => api.next(c, b!)],
  ["POST", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/skips\/clear$/, (c, b) => api.clearSkips(c, b!)],
  ["GET", /^\/api\/proposals\/(\d+)$/, (c, id) => api.showProposal(c, int(id!))],
  ["POST", /^\/api\/proposals\/(\d+)\/decision$/, (c, id) => api.decide(c, int(id!))],
  ["POST", /^\/api\/proposals\/(\d+)\/skip$/, (c, id) => api.skip(c, int(id!))],
  ["GET", /^\/api\/admin\/progress$/, (c) => api.adminProgress(c)],
  ["GET", /^\/api\/admin\/batches\/([A-Za-z0-9._-]{1,100})\/export$/, (c, b) => api.adminExport(c, b!)],
];

export async function handle(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
  const ctx: Ctx = { env, request, url, exec, now: Date.now() };
  try {
    let pathMatched = false;
    for (const [method, pattern, handler] of ROUTES) {
      const m = pattern.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (method !== request.method) continue;
      return await handler(ctx, ...m.slice(1));
    }
    throw pathMatched ? new HttpError(405, "method_not_allowed") : new HttpError(404, "not_found");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    const message = err instanceof Error ? err.message : String(err);
    if (/is not configured$/.test(message)) return json({ error: "server_misconfigured" }, 500);
    console.error("unhandled", message);
    return json({ error: "internal_error" }, 500);
  }
}

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
