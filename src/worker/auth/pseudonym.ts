import { hex, hmacSha256, requireSecret } from "../crypto";
import type { Env } from "../env";

/**
 * The reviewer id: HMAC-SHA256(REVIEWER_ID_SECRET, "<provider>:<subject>"), first 8 hex digits, as rv_xxxxxxxx
 * (hocrgen's reviewer id format, ^rv_[0-9a-z]{8}$). It is stable for a person and reveals nothing about their Google
 * account. 32 bits: two people share an id with probability about n^2 / 2^33 (about 1e-4 for 1,000 reviewers).
 */
export async function reviewerIdFor(env: Env, provider: string, subject: string): Promise<string> {
  const secret = requireSecret(env.REVIEWER_ID_SECRET, "REVIEWER_ID_SECRET");
  return "rv_" + hex(await hmacSha256(secret, `${provider}:${subject}`)).slice(0, 8);
}
