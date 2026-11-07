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
    }
  }
}
export {};
