import { readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { buildImportStatements } from "./scripts/lib/importsql";
import { buildSubsetStatements, interimMembers } from "./scripts/lib/subset";
import type { TaskImporter } from "./src/tasks/import";
import { lineConsensusImporter } from "./src/tasks/line_consensus/importer";
import { goldImport, type GoldFile } from "./src/tasks/line_verify/gold";
import type { LvItemsFile } from "./src/tasks/line_verify/schema";
import { lineVerifyImporter } from "./src/tasks/line_verify/importer";
import { pageReviewImporter } from "./src/tasks/page_review/importer";
import { referenceAuditImporter } from "./src/tasks/reference_audit/importer";
import type { ProposalMedia } from "./src/tasks/types";

/** One fixture batch as SQL statements, with fake static media, for the Worker tests. */
function fixtureBatch(importer: TaskImporter, path: string, minReviewers: number, importedAt: string, sidecars?: Record<string, string>): string[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const side = Object.fromEntries(Object.entries(sidecars ?? {}).map(([k, v]) => [k, JSON.parse(readFileSync(v, "utf8")) as unknown]));
  const bundle = importer.bundle(raw, side);
  const media = new Map<string, ProposalMedia>(
    bundle.proposals.map((p) => [
      p.externalId,
      {
        crop: { ref: { source: "static", path: `media/fixture/${p.externalId.replace(/[^A-Za-z0-9._-]/g, "_")}.jpg` }, width: 400, height: 120, box: [0.2, 0.3, 0.6, 0.7] },
        page: { ref: { source: "static", path: `media/fixture/page.jpg` }, width: 1000, height: 1400, box: p.pageBox },
      },
    ]),
  );
  return buildImportStatements(bundle, media, { minReviewers, importedAt, after: importer.afterImportSql?.(bundle.batch.id, importedAt) });
}

/** A manifest with scans and no line boxes, using the real schema and import SQL. */
function emptyLineVerifyBatch(): string[] {
  const raw = JSON.parse(readFileSync("test/fixtures/line_verify_v12/items.json", "utf8")) as LvItemsFile;
  raw.batch_id = "fixture_line_verify_empty";
  raw.pages = raw.pages.map((p) => ({ ...p, kraken_lines: 0 }));
  raw.items = [];
  raw.blind_second_pass = [];
  const problems = lineVerifyImporter.problems(raw);
  if (problems.length) throw new Error(problems.join("\n"));
  const bundle = lineVerifyImporter.bundle(raw);
  const itemImages = new Map(bundle.items.map((p) => [
    p.externalId,
    { ref: { source: "static" as const, path: "media/fixture/empty-page.jpg" }, width: 1000, height: 1400, box: null },
  ]));
  return buildImportStatements(bundle, new Map(), { minReviewers: 1, importedAt: "2026-11-20T00:00:00.000Z", itemImages });
}

/** The synthetic P-hist gold fixture added to the volunteer fixture batch, as scripts/import-gold.ts adds it. */
function lineVerifyGoldSql(batchId: string): string[] {
  const file = JSON.parse(readFileSync("test/fixtures/line_verify_gold/phist_gold_v1_1_1.json", "utf8")) as GoldFile;
  const { items, proposals } = goldImport(file);
  const media = new Map<string, ProposalMedia>(
    proposals.map((p) => [
      p.externalId,
      {
        crop: { ref: { source: "static", path: `media/fixture/${p.externalId.replace(/[^A-Za-z0-9._-]/g, "_")}.jpg` }, width: 400, height: 120, box: [0.2, 0.3, 0.6, 0.7] },
        page: { ref: { source: "static", path: "media/fixture/page.jpg" }, width: 1000, height: 1400, box: p.pageBox },
      },
    ]),
  );
  return buildImportStatements({ batch: { id: batchId, taskType: "line_verify", title: "", source: {} }, items, proposals }, media, { minReviewers: 1, importedAt: "2026-11-19T00:00:00.000Z", addOnly: true });
}

const LINE_CONSENSUS = "test/fixtures/line_consensus";

/** The volunteer line batch (fixture line items, exclusions, maintainer-decided record, hints and gold). */
function lineConsensusBatch(): string[] {
  const side = (n: string) => `${LINE_CONSENSUS}/${n}`;
  return fixtureBatch(lineConsensusImporter, side("line_items_v1.json"), 1, "2026-11-18T12:00:00.000Z", {
    "volunteer_exclusions_v3.json": side("volunteer_exclusions_v3.json"),
    "maintainer_decided.json": side("maintainer_decided.json"),
    "ai_flags.json": side("ai_flags.json"),
    "gold_v1.json": side("gold_v1.json"),
  });
}

const PAGE_REVIEW = "test/fixtures/page_review";

/** The page review batch imported again with Claude's first-pass hints (ai_flags.json), as lead's import will. */
function pageReviewWithAiFlags(minReviewers: number): string[] {
  return fixtureBatch(pageReviewImporter, `${PAGE_REVIEW}/batch_manifest.json`, minReviewers, "2026-11-12T12:00:00.000Z", {
    "blind_prefill.json": `${PAGE_REVIEW}/blind_prefill.json`,
    "ai_flags.json": `${PAGE_REVIEW}/ai_flags.json`,
  });
}

/** The page review fixture's interim subset (the subset tables only), as `npm run import-subset` loads it. */
function pageReviewSubset(): string[] {
  const raw: unknown = JSON.parse(readFileSync(`${PAGE_REVIEW}/interim_fixture.json`, "utf8"));
  return buildSubsetStatements("newprinted_midcentury_v0", { id: "interim_fixture", title: "סט ביניים", sourceSha256: "fixture" }, interimMembers(raw), "2026-11-15T00:00:00.000Z");
}

/** The line_verify_items.v1.1 fixture batch (pre-check flags, a blind second pass), loaded by its own tests only. */
function lineVerifyV11Batch(): string[] {
  return fixtureBatch(lineVerifyImporter, "test/fixtures/line_verify_v11/items.json", 1, "2026-11-18T00:00:00.000Z");
}

/** The line_verify_items.v1.2 fixture batch (typed lines, kraken coverage), loaded by its own tests only. */
function lineVerifyV12Batch(): string[] {
  return fixtureBatch(lineVerifyImporter, "test/fixtures/line_verify_v12/items.json", 1, "2026-11-18T00:00:00.000Z");
}

/** The volunteer_v1 fixture batch (the v1.2 lines, no blind pass), loaded by its own tests only. */
function lineVerifyVolBatch(): string[] {
  return fixtureBatch(lineVerifyImporter, "test/fixtures/line_verify_vol/items.json", 1, "2026-11-18T00:00:00.000Z");
}

/** The fixture batches: the reference audit (imported first), line verification and page review. */
function fixtureStatements(minReviewers: number): string[] {
  return [
    ...fixtureBatch(referenceAuditImporter, "test/fixtures/proposals.fixture.json", minReviewers, "2026-11-07T00:00:00.000Z"),
    ...fixtureBatch(lineVerifyImporter, "test/fixtures/line_verify/items.json", minReviewers, "2026-11-07T00:00:01.000Z"),
    ...fixtureBatch(pageReviewImporter, "test/fixtures/page_review/batch_manifest.json", minReviewers, "2026-11-07T00:00:02.000Z", {
      "blind_prefill.json": "test/fixtures/page_review/blind_prefill.json",
    }),
  ];
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  const intakeMigrations = await readD1Migrations("intake/migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                d1Databases: { HANDWRITING_DB: "fixture-handwriting" },
                r2Buckets: { HANDWRITING_MEDIA: "fixture-handwriting-media", HANDWRITING_CONTROL: "fixture-handwriting-control", TRAIN_CAPTURE_MEDIA: "fixture-train-captures" },
                bindings: {
                  ENVIRONMENT: "development",
                  DEV_AUTH_BYPASS: "1",
                  SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
                  REVIEWER_ID_SECRET: "test-reviewer-id-secret-0123456789abcdef012345",
                  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
                  ADMIN_REVIEWER_IDS: "",
                  TEST_MIGRATIONS: migrations,
                  TEST_HANDWRITING_MIGRATIONS: intakeMigrations,
                  TEST_FIXTURE_SQL: fixtureStatements(1),
                  TEST_PAGE_REVIEW_AI_SQL: pageReviewWithAiFlags(1),
                  TEST_SUBSET_SQL: pageReviewSubset(),
                  TEST_LINE_CONSENSUS_SQL: lineConsensusBatch(),
                  TEST_LINE_VERIFY_V11_SQL: lineVerifyV11Batch(),
                  TEST_LINE_VERIFY_V12_SQL: lineVerifyV12Batch(),
                  TEST_LINE_VERIFY_EMPTY_SQL: emptyLineVerifyBatch(),
                  TEST_LINE_VERIFY_VOL_SQL: lineVerifyVolBatch(),
                  TEST_LINE_VERIFY_GOLD_SQL: lineVerifyGoldSql("fixture_line_verify_vol"),
                },
              },
            }),
          ],
          test: {
            name: "worker",
            // Multi-request D1 flows can exceed the default 5 seconds on CI runners.
            testTimeout: 15_000,
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/setup.ts"],
          },
        },
        {
          test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" },
        },
        {
          // Browser view code against a minimal fake document (no DOM library in the dependencies).
          test: { name: "web", include: ["test/web/**/*.test.ts"], environment: "node" },
        },
      ],
    },
  };
});
