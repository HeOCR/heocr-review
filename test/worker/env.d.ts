import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as AppEnv } from "../../src/worker/env";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("../../src/worker/index");
    }
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_FIXTURE_SQL: string[];
      /** The page review batch imported again with ai_flags.json. */
      TEST_PAGE_REVIEW_AI_SQL: string[];
      /** The page review fixture's interim subset (subset tables only). */
      TEST_SUBSET_SQL: string[];
      /** The volunteer line batch (line_consensus). */
      TEST_LINE_CONSENSUS_SQL: string[];
      TEST_LINE_VERIFY_V11_SQL: string[];
    }
  }
}
export {};
