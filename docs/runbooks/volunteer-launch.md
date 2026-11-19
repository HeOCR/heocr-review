# Runbook: the volunteer launch (DRAFT, not run)

> **Status: prepared 2026-11-19, nothing run.** Every step waits for the maintainer's explicit go for the whole
> volunteer launch, relayed by heocr-lead. If any check fails, stop there and report to heocr-lead; never fix forward on
> production.

The launch puts the volunteer line review (`line_consensus`, the mid-century batch) and the two P-hist test batches
(`line_verify`, resolution `volunteer_v1`) on production, with the approved privacy text.

## What must be true first

Each item is owned by the session named, and all of them must hold before step 0.

1. **The maintainer's go**, relayed word for word by heocr-lead.
2. **Gold** (heocr-eval): `gold_v1.json` registered, and imported to the gate batch. Without it no
   volunteer can reach standing, so no volunteer decision counts in either batch.
3. **Privacy re-cut** (heocr-eval registers, contrib imports): the mid-century exclusions file with the pages the
   private-names screen dropped (reason `privacy`), registered. Then a heocr-review PR moves `REGISTERED_SHA256` in
   `src/tasks/line_consensus/schema.ts` to it. The prepared re-cut validates (dry run, 2026-11-19): 219 pages.
4. **Rights** (heocr-data-collection): a rights justification per source, with its US status.
5. **Public exports** (contrib, HeOCR/heocr-review#30): anything public goes through `npm run export -- --public` and
   `npm run check-public`.
6. **Volunteer review switched on:** a heocr-review PR that sets `CONSENSUS_ENABLED` to `"1"` in the production
   `vars` of `wrangler.jsonc`, merged before step 2.
7. **P-hist test batches:** the bundles whose sha256 eval pinned, checked on a local Worker (there is no preview
   environment since 2026-11-19).
8. **The maintainer's line-level gold batch** (`newprinted_midcentury_goldlines_v0`, live since 2026-11-19): production
   has no per-batch access control, so it is "admin only" only while the maintainer is the only reviewer. Before the
   launch deploy, close it (status `closed`) once its lines are decided and exported to eval, or gate it in the launch
   code. Volunteers must never be served it.

## The privacy text

Production runs whatever main ships. At launch that is:

- the privacy policy **2026-11-18-v3** (`PRIVACY_VERSION`), which adds the check-lines item. Approved:
  [decision record](../decisions/2026-11-18-check-lines.md);
- the terms **2026-11-18-v1** (`TERMS_VERSION`). Approved:
  [decision record](../decisions/2026-11-18-terms-handwriting.md). Production runs 2026-11-12-v1 today, so every
  reviewer, the maintainer included, is asked to accept again before their next decision.

The two decision records say this text goes to production only with the volunteer launch. This runbook is that
deploy, so there is no separate privacy-text deploy.

## Steps

0. **Preparation.**
   - Use the main clone on main: a clean tree, `npm ci`, and `npm test` green. Record the sha.
   - Record the live Worker version id (`wrangler deployments list`) for rollback.
   - Record a D1 Time Travel bookmark. Reading it changes nothing.
   - Record each production batch's current decision count.
   - **Write budget:** add up the launch's imports (the volunteer batch, both P-hist batches and their gold) with
     each script's `--dry-run` estimate. Together they must fit the day's budget
     (`docs/runbooks/testing-and-imports.md`); the scripts refuse an import that does not.
   - **Full D1 export** (heocr-lead, 2026-11-19), because migration 0010 rebuilds two tables:
     `npx wrangler d1 export DB --remote --env= --output <private path>`. The output path is outside every repository
     and every synced folder, mode 0600: the export holds reviewer pseudonyms and every decision. Record its sha256,
     and a row count per table (`SELECT name FROM sqlite_master WHERE type = 'table'`, then `SELECT COUNT(*)` for each).
     Print counts only, never rows.
     - Production is at 0004 today. `batch_settings` (0006) and `verify_votes` (0009) don't exist there yet, so
       0010 rebuilds tables created empty earlier in the same deploy. The tables that hold data (`decisions`,
       `reviewers`, `consent_events`, `proposals`, `items`, `batches`, `drafts`, `subsets`, `subset_members`) are
       untouched by 0005–0011, and the counts prove it.
     - The export file is kept until the launch is verified and heocr-lead closes it out. It is never committed,
       uploaded or sent.
1. **Media.**
   - Run `.import/privacy/recut/media_removal.sh` (local, git-ignored). It moves the dropped pages' images out of
     `public/media/newprinted_midcentury_v0` and out of the volunteer media hold, into
     `.import/held-media/privacy-dropped/`. Nothing is deleted.
   - Copy the volunteer media hold into `public/media`. From the launch on, it is served.
   - Check that `public/media` has no dropped page, and that the volunteer folder holds exactly the re-cut's pages.
2. **Deploy code and migrations:** `tsx scripts/deploy.ts production --yes-production`. This applies migrations
   0005 to 0011 and ships the privacy text above. 0005–0009 and 0011 are additive (0011 also sets `pointed_books =
   keep` on the pointed batch and the gold-lines batch). 0010 rebuilds `batch_settings` and `verify_votes` with their
   rows, to widen two CHECKs.
   - **Right after it,** before step 3, recount every table from step 0's list. Every count must be unchanged, and the
     new tables are empty. If any count differs, stop, roll back the Worker, and report to heocr-lead. The export is the
     reference.
3. **Data, production:**
   - Apply `.import/privacy/recut/v0_deactivate_dropped.sql`. It takes the dropped pages out of the maintainer's
     page review, since their images are gone. They had 0 decisions on 2026-11-19; check again first.
   - Import the mid-century re-cut:
     `npm run import -- --task line_consensus --bundle <re-cut bundle> --target production --yes-production`.
   - Import both P-hist bundles with `--task line_verify`.
   - Straight after each P-hist import, run
     `npm run batch-setting -- --batch <id> --resolution volunteer_v1 --by <who>`. It refuses a batch that has
     decisions. If it refuses, close that batch and stop.
4. **Deploy again**, so the new media is served. Use the same command; the migrations are a no-op.
5. **Checks** (all read-only):
   - migrations 0001 to 0011 are applied;
   - `/api/config` gives `termsVersion` 2026-11-18-v1, and `/privacy` shows 2026-11-18-v3;
   - each batch's progress SQL, timed on production D1;
   - one media file per batch returns 200;
   - each dropped page's old URL returns 404, in both mid-century folders;
   - the gate batch has gold lines;
   - signed in, the volunteer line review serves a line;
   - the existing decision counts are unchanged from step 0;
   - `npm run check-public` passes on a `--public` export of each volunteer batch.
6. **Report to heocr-lead.**

## Rollback

- **The Worker:** `wrangler rollback` to the version recorded in step 0. This brings back the old terms and privacy
  text.
- **Volunteer review only:** redeploy without `CONSENSUS_ENABLED`, and every `line_consensus` route returns 404.
  Close a batch with its status set to `closed`; reopening it is the reverse.
- **The migrations** are additive and harmless to the old code.
- **The Time Travel bookmark** is a last resort, and needs the maintainer's word.

These cannot be undone:

- **The media removal stays,** even on rollback. Browsers and caches keep what they already fetched: media is served
  `immutable` for a year.
- **CC0 contributions,** once published.

## The private-names screen (2026-11-19)

This summary gives counts only. The page list, the screen's scripts and its output are local, in
`.import/privacy/`, git-ignored.

- **Rule:** eval's mid-century sample plan, §B6: drop any page with a private person's details. Pages are dropped
  whole, not cropped: the app shows the whole page image.
- **Automated pass:**
  - dictabert-ner person spans;
  - hocrgen's `plenary_private_names_v1` gate (`gate_stream_lines`, the packaged roster) on all 222 pages;
  - for the Reshumot pages, a pattern pass as well (ID numbers, street addresses, private-person cues).
  - It flagged 141 pages: 66 of 82 plenary, 37 of 70 קובץ התקנות, 38 of 70 ספר החוקים.
- **Hand check:**
  - every flagged mention, plus a seeded random 20 of the 81 unflagged pages;
  - in the Reshumot, every name is a signatory in office (ministers, heads of local authorities, officials) or NER
    noise;
  - in the plenary, most are MKs, ministers, officials and public figures.
- **Dropped:** 3 plenary pages. They name private people with personal details (residence, family, occupation, a death, an estate).
- **For the maintainer:** 3 edge cases.
- **The sample** found nothing.
