import * as api from "./api";
import type { Ctx } from "./api";
import type { Env } from "./env";
import { HttpError, errorResponse, json } from "./http";
import { isD1QuotaError, secondsToUtcMidnight } from "./ratelimit";

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
  ["GET", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/page-paste\/next$/, (c, b) => api.pasteNext(c, b!)],
  ["POST", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/page-paste\/(\d{1,15})$/, (c, b, i) => api.pasteSave(c, b!, int(i!))],
  ["POST", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/skips\/clear$/, (c, b) => api.clearSkips(c, b!)],
  ["POST", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/pages\/(\d+)\/check$/, (c, b, i) => api.checkPage(c, b!, int(i!))],
  ["POST", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/pages\/(\d+)\/lines$/, (c, b, i) => api.addPageLine(c, b!, int(i!))],
  ["POST", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/pages\/(\d+)\/done$/, (c, b, i) => api.finishPage(c, b!, int(i!))],
  ["DELETE", /^\/api\/batches\/([A-Za-z0-9._-]{1,100})\/added-lines\/(pl-[0-9a-f]{16})$/, (c, b, l) => api.removePageLine(c, b!, l!)],
  ["GET", /^\/api\/proposals\/(\d+)$/, (c, id) => api.showProposal(c, int(id!))],
  ["POST", /^\/api\/proposals\/(\d+)\/decision$/, (c, id) => api.decide(c, int(id!))],
  ["POST", /^\/api\/proposals\/(\d+)\/skip$/, (c, id) => api.skip(c, int(id!))],
  ["PUT", /^\/api\/proposals\/(\d+)\/draft$/, (c, id) => api.saveDraft(c, int(id!))],
  ["DELETE", /^\/api\/proposals\/(\d+)\/draft$/, (c, id) => api.clearDraft(c, int(id!))],
  ["POST", /^\/api\/synth-realism\/([A-Za-z0-9._-]{1,100})\/next$/, (c, b) => api.synthNext(c, b!)],
  ["POST", /^\/api\/synth-realism\/([A-Za-z0-9._-]{1,100})\/trials\/(sr-[0-9a-f]{32})\/choice$/, (c, b, r) => api.synthChoice(c, b!, r!)],
  ["POST", /^\/api\/synth-realism\/([A-Za-z0-9._-]{1,100})\/trials\/(sr-[0-9a-f]{32})\/feedback$/, (c, b, r) => api.synthFeedback(c, b!, r!)],
  ["GET", /^\/api\/synth-realism\/([A-Za-z0-9._-]{1,100})\/trials\/(sr-[0-9a-f]{32})\/asset\/([01])\/(page|line)$/, (c, b, r, side, kind) => api.synthAsset(c, b!, r!, side === "0" ? 0 : 1, kind as "page" | "line")],
  ["GET", /^\/api\/admin\/progress$/, (c) => api.adminProgress(c)],
  ["GET", /^\/api\/admin\/batches\/([A-Za-z0-9._-]{1,100})\/export$/, (c, b) => api.adminExport(c, b!)],
  ["GET", /^\/api\/admin\/batches\/([A-Za-z0-9._-]{1,100})\/volunteers$/, (c, b) => api.adminVolunteers(c, b!)],
  ["PUT", /^\/api\/admin\/batches\/([A-Za-z0-9._-]{1,100})\/reviewers\/(rv_[0-9a-f]{8})\/exclusion$/, (c, b, r) => api.adminExclusion(c, b!, r!)],
  ["PUT", /^\/api\/admin\/phist-gold\/([A-Za-z0-9._-]{1,100})$/, (c, g) => api.adminPhistGoldPull(c, g!)],
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
    if (isD1QuotaError(message)) {
      console.error("d1 quota", message);
      return json({ error: "daily_limit", message: "the site's daily database quota is used up" }, 429, { "retry-after": String(secondsToUtcMidnight()) });
    }
    console.error("unhandled", message);
    return json({ error: "internal_error" }, 500);
  }
}

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
