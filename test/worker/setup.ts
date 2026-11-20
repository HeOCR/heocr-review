import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { resetRateLimits } from "../../src/worker/ratelimit";

// Storage is isolated per test file; reset tables before every test so each starts from the fixture.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  resetRateLimits();
  const tables = ["page_flag_answers", "page_flags", "pointed_book_drops", "phist_gold_grades", "phist_gold_pulls", "verify_votes", "verify_state", "batch_settings", "maintainer_decisions", "line_state", "agreement_exclusions", "drafts", "subset_members", "subsets", "rate_limits", "assignments", "skips", "decisions", "consent_events", "reviewers", "proposals", "items", "batches"];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch(env.TEST_FIXTURE_SQL.map((s) => env.DB.prepare(s)));
});
