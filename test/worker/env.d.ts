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
    }
  }
}
export {};
