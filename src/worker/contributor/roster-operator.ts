import { CONTRIBUTOR_API } from "../../shared/contributor";
import type { Ctx } from "../api";
import { HttpError } from "../http";
import { canonicalContributorOrigin, gone, hash, ROSTER_OPERATOR_ID } from "./config";
import { handwritingPlan, handwritingRoster } from "./handwriting";

export const ROSTER_OPERATOR_PATH = CONTRIBUTOR_API + "/operator/handwriting-roster";
const tokenPattern = /^Bearer (heocr_roster_v1_[A-Za-z0-9_-]{43})$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const windowS = 300;
const encoder = new TextEncoder();

/** This namespace never falls back to session auth on another route. */
export function hasRosterBearer(request: Request) {
  return /^Bearer +heocr_roster_v1_/i.test(request.headers.get("authorization") ?? "");
}

export async function rosterOperator(ctx: Ctx) {
  const { env, request, url } = ctx;
  const method = request.method;
  const origin = request.headers.get("origin");
  if ((method !== "GET" && method !== "POST") || url.search || !canonicalContributorOrigin(env,url) ||
      (origin !== null && origin !== url.origin) || env.CONTRIBUTOR_ROSTER_REVIEWER_ID !== ROSTER_OPERATOR_ID ||
      !env.CONTRIBUTOR_HANDWRITING_CONFIG_SHA256) throw gone();

  const token = tokenPattern.exec(request.headers.get("authorization") ?? "")?.[1];
  const verifier = env.CONTRIBUTOR_ROSTER_TOKEN_SHA256;
  if (!token || !verifier || !digestPattern.test(verifier) ||
      !crypto.subtle.timingSafeEqual(encoder.encode(await hash(token)),encoder.encode(verifier))) throw gone();

  // Rate and audit share one atomic write. Rejected and over-limit requests write nothing.
  const start = Math.floor(ctx.now / (windowS * 1000)) * windowS * 1000;
  const end = start + windowS * 1000;
  const limit = method === "GET" ? 6 : 3;
  const admission = await env.DB.prepare(`INSERT INTO contributor_handwriting_roster_access
    (principal,method,requested_at_ms)
    SELECT ?1,?2,?3
    WHERE (SELECT COUNT(*) FROM contributor_handwriting_roster_access WHERE method=?2 AND requested_at_ms>=?4 AND requested_at_ms<?5) < ?6`)
    .bind(ROSTER_OPERATOR_ID,method,ctx.now,start,end,limit).run();
  if (admission.meta.changes !== 1) {
    const retry = Math.ceil((end - ctx.now) / 1000);
    throw new HttpError(429,"rate_limited",undefined,{"retry-after":String(retry)});
  }

  const signup = await handwritingPlan(ctx);
  if (!signup) throw gone();
  return handwritingRoster(ctx,signup);
}
