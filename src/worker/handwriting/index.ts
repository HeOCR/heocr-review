import type { Env } from "../env";
import { assertSameOrigin, errorResponse, HttpError, json } from "../http";
import { asReviewer, intakeContext, notFound, prefix, type Role, type Intake } from "./core";
import { geometry, intakeList, inviteInfo, issue, original, screen, split, upload } from "./intake";
import { adjudicate, crop, readerAgreement, reviewView, typeLine } from "./review";
import { buildCandidate, candidate, candidateAsset, closeCollection, consentLedger, evalCheck, reconcile, withdraw } from "./release";
import { intakeForm } from "./form";

const formPath = "/handwriting-intake";
export function isHandwritingPath(path: string) {
  return path === formPath || path.startsWith(formPath + "/") || path === prefix || path.startsWith(prefix + "/");
}

const id = "([a-f0-9]{32})";
const pair = "/pages/" + id + "/versions/" + id;
const hash = "([a-f0-9]{64})";
const reviewers: Role[] = ["reader", "adjudicator"];
const routes: [method: string, path: string, roles: Role[], run: (c: Intake, user: string, ...parts: string[]) => Response | Promise<Response>][] = [
  ["GET", "/invitation", [], inviteInfo],
  ["POST", "/upload", [], upload],
  ["POST", "/operator/invitations", ["operator"], c => issue(c)],
  ["POST", "/operator/pages/" + id + "/retake", ["operator"], (c, _, p) => issue(c, p)],
  ["GET", "/intake/submissions", ["intake"], intakeList],
  ["GET", "/intake" + pair + "/original", ["intake"], (c, _, p, v) => original(c, p!, v!)],
  ["POST", "/intake" + pair + "/screen", ["intake"], (c, user, p, v) => screen(c, user, p!, v!)],
  ["POST", "/intake" + pair + "/geometry", ["intake"], (c, _, p, v) => geometry(c, p!, v!)],
  ["GET", "/eval/lineage", ["eval"], evalCheck],
  ["POST", "/eval" + pair + "/split", ["eval"], (c, _, p, v) => split(c, p!, v!)],
  ["GET", "/review/consent", reviewers, (c, user) => readerAgreement(c, user, false)],
  ["POST", "/review/consent", reviewers, (c, user) => readerAgreement(c, user, true)],
  ["GET", "/review/next", reviewers, (c, user) => reviewView(c, user)],
  ["GET", "/review/" + id, reviewers, (c, user, l) => reviewView(c, user, l!)],
  ["GET", "/review/" + id + "/image", reviewers, (c, user, l) => crop(c, user, l!)],
  ["POST", "/review/" + id, reviewers, (c, user, l) => typeLine(c, user, l!)],
  ["GET", "/review/" + id + "/adjudicate", ["adjudicator"], (c, user, l) => adjudicate(c, user, l!, false)],
  ["POST", "/review/" + id + "/adjudicate", ["adjudicator"], (c, user, l) => adjudicate(c, user, l!, true)],
  ["POST", "/operator/withdraw", ["operator"], withdraw],
  ["POST", "/operator/close", ["operator"], closeCollection],
  ["POST", "/operator/reconcile", ["operator"], reconcile],
  ["GET", "/operator/consent", ["operator"], consentLedger],
  ["POST", "/operator/candidates", ["operator"], buildCandidate],
  ["GET", "/operator/candidates/" + hash, ["operator"], (c, _, h) => candidate(c, h!)],
  ["GET", "/operator/candidates/" + hash + "/asset/([1-9][0-9]?)/([0-9]{1,2})", ["operator"],
    (c, _, h, p, l) => candidateAsset(c, h!, Number(p), Number(l))],
];
const compiled = routes.map(([method, path, allowed, run]) => ({ method, matcher: new RegExp("^" + prefix + path + "$"), allowed, run }));

export async function handwriting(request: Request, env: Env, path: string) {
  try {
    const c = await intakeContext(request, env);
    if (request.method === "GET" && (path === formPath || path === formPath + "/")) return intakeForm(false);
    if (request.method === "GET" && path === formPath + "/review") {
      await asReviewer(c, ...reviewers);
      return intakeForm(true);
    }
    for (const { method, matcher, allowed, run } of compiled) {
      const match = path.match(matcher);
      if (!match || method !== request.method) continue;
      if (method !== "GET") assertSameOrigin(request);
      const user = allowed.length ? await asReviewer(c, ...allowed) : "";
      return await run(c, user, ...match.slice(1));
    }
    throw notFound();
  } catch (error) {
    // Provider errors may contain protected SQL bindings or paths.
    return error instanceof HttpError ? errorResponse(error) : json({ error: "intake_unavailable" }, 503);
  }
}
