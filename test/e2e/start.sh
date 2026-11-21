#!/bin/sh
set -eu
# Dedicated, disposable local D1; never use the developer's usual Wrangler state.
STATE="$PWD/.e2e-state-$$"
mkdir -p "$STATE"
trap 'rm -rf "$STATE"' EXIT INT TERM
npx tsx test/e2e/seed.ts "$STATE/seed.sql"
npx wrangler d1 migrations apply DB --local --persist-to "$STATE" > /dev/null
npx wrangler d1 execute DB --local --persist-to "$STATE" --file "$STATE/seed.sql" > /dev/null
npm run build
REVIEWER_SECRET=e2e-reviewer-secret-0123456789abcdef
RANKING_REVIEWER=$(node -e 'console.log("rv_" + require("node:crypto").createHmac("sha256", process.argv[1]).update("dev:ranking-e2e").digest("hex").slice(0, 8))' "$REVIEWER_SECRET")
npx wrangler dev --local --persist-to "$STATE" --ip 127.0.0.1 --port 18787 --infer-origin-from-routes=false --var ENVIRONMENT:development --var DEV_AUTH_BYPASS:1 --var SESSION_SECRET:e2e-session-secret-0123456789abcdef --var REVIEWER_ID_SECRET:"$REVIEWER_SECRET" --var GOOGLE_CLIENT_ID: --var REALISM_RANKING_ENABLED:1 --var ADMIN_REVIEWER_IDS:"$RANKING_REVIEWER" --var RESTRICTED_REFERENCE_REVIEWER_ID:"$RANKING_REVIEWER"
