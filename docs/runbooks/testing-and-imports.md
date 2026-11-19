# Runbook: testing, and imports against the D1 write budget

> **Why this exists.** On 2026-11-19, repeated large imports to the preview database used up the Cloudflare account's
> daily D1 row-write budget. The free plan allows 100,000 rows written a day, shared by every database in the
> account. Production then refused every request (the rate limiter wrote a row on each one) until the plan changed.
> The maintainer's decisions, the same day: upgrade the plan, never burn quota like that again, take the test
> environment down, and test locally (or at most on a separate Cloudflare account).

## Where to test

- **On a local Worker, always.** Run `npm run dev` (local D1, the dev sign-in, `.dev.vars`).
  - Fixtures: `npm test` loads them; for the app, import a fixture bundle with `--target local`.
  - Real data when needed: `npx wrangler d1 export DB --remote --env= --output <private path>`, then
    `npx wrangler d1 execute DB --local --file <that file>`.
    - The private path is outside every repository and synced folder, mode 0600: the export holds every decision and
      pseudonym. Delete the local copy (`.wrangler/state/v3/d1`) and the file when done, unless a runbook keeps it.
    - To act as the admin, put the dev reviewer's `rv_…` in `.dev.vars` as `ADMIN_REVIEWER_IDS` and restart. Remove
      it afterwards.
  - Phone layouts: the in-app browser at the phone's size (for example 412×915), light and dark.
- **There is no preview environment.** It was removed on 2026-11-19. A separate Cloudflare account, if one is ever set
  up, is the only remote test target. Nothing is ever tested on production's account except the production launch
  checks.

## Imports to production

1. **Run it locally first:** the same bundle, `--target local`, then the app on a local Worker.
2. **Estimate:** run the script with `--dry-run --target production --yes-production`. It prints
   `estimated_rows_written` (a conservative count: every row, plus one per index it touches; a large batch's re-import
   counts its reset too).
3. **Budget:** on a real run, the script reads today's rows written across the account from Cloudflare's analytics. It
   refuses when today plus the estimate passes 80% of `D1_DAILY_WRITE_BUDGET` (in `~/.config/heocr/cloudflare.env`;
   default 100,000, the free plan's daily limit; set it to the plan's figure after an upgrade).
   - `--over-budget` overrides, only with the maintainer's word.
   - `--budget-unknown` imports when the analytics can't be read, only with the maintainer's word.
4. **Never repeat a large import to fix a small thing.** Prefer a targeted `UPDATE` (counted the same way: rows changed,
   plus their index entries), or batch the changes into one import. A line_consensus re-import of the volunteer batch
   writes about 110,000 rows.

## Bulk updates by hand

Count the rows first (`SELECT COUNT(*)` with the same `WHERE`) and include them in the day's budget, as for an import.
Take a private export of production first when the update deactivates or changes decisions' lines.
