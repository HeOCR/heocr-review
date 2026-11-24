import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { resetRateLimits } from "../../src/worker/ratelimit";

// Storage is isolated per test file; reset tables before every test so each starts from the fixture.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  resetRateLimits();
  const tables = ["reference_consensus_lines", "reference_consensus_runs", "contributor_handwriting_pins", "contributor_handwriting_revoked_invites", "contributor_handwriting_roster", "contributor_submissions", "contributor_enrolments", "restricted_reference_pages", "page_paste_train_history", "page_paste_train_decisions", "page_paste_train_assets", "page_paste_train_pages", "synth_ranking_answers", "synth_ranking_pairs", "synth_realism_trials", "synth_realism_items", "synth_realism_assets", "page_added_lines", "page_checks", "triage_plants", "pointed_book_drops", "phist_gold_grades", "phist_gold_pulls", "verify_votes", "verify_state", "batch_settings", "maintainer_decisions", "line_state", "agreement_exclusions", "drafts", "subset_members", "subsets", "rate_limits", "assignments", "skips", "decisions", "consent_events", "reviewers", "proposals", "items", "batches"];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch(env.TEST_FIXTURE_SQL.map((s) => env.DB.prepare(s)));
});
