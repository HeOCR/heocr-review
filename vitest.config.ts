import { readFileSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { buildImportStatements } from "./scripts/lib/importsql";
import { referenceAuditImporter } from "./src/tasks/reference_audit/importer";
import type { ProposalMedia } from "./src/tasks/types";

/** The fixture batch as SQL statements, with fake static media, for the Worker tests. */
function fixtureStatements(minReviewers: number): string[] {
  const raw: unknown = JSON.parse(readFileSync("test/fixtures/proposals.fixture.json", "utf8"));
  const bundle = referenceAuditImporter.bundle(raw);
  const media = new Map<string, ProposalMedia>(
    bundle.proposals.map((p) => [
      p.externalId,
      {
        crop: { ref: { source: "static", path: `media/fixture/${p.externalId}.jpg` }, width: 400, height: 120, box: [0.2, 0.3, 0.6, 0.7] },
        page: { ref: { source: "static", path: `media/fixture/page.jpg` }, width: 1000, height: 1400, box: p.pageBox },
      },
    ]),
  );
  return buildImportStatements(bundle, media, { minReviewers, importedAt: "2026-11-07T00:00:00.000Z" });
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  ENVIRONMENT: "development",
                  DEV_AUTH_BYPASS: "1",
                  SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
                  REVIEWER_ID_SECRET: "test-reviewer-id-secret-0123456789abcdef012345",
                  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
                  ADMIN_REVIEWER_IDS: "",
                  TEST_MIGRATIONS: migrations,
                  TEST_FIXTURE_SQL: fixtureStatements(1),
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/setup.ts"],
          },
        },
        {
          test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" },
        },
      ],
    },
  };
});
