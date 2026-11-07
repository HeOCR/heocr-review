# Repository Agent Instructions

## Scope
- Keep this file static and procedural. Put evolving status in PRs and the HeOCR planning docs, not here.

## Setup and validation
- Install: `npm ci`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Test: `npm test` (builds the frontend, runs the Worker tests in workerd with a local D1, and the node tests)
- hocrgen contract test: set `HOCRGEN_DIR` to a hocrgen checkout on `main` (default `~/clones/hocrgen`); with
  `HOCRGEN_REQUIRED=1` the test fails instead of skipping when hocrgen is missing (CI sets it).
- Local app: `cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev`

## Branching and PRs
- Start new work from the latest `main`: `git checkout main && git pull --ff-only origin main && git checkout -b feat/<topic>`.
- Open a ready (non-draft) PR into `main` with what changed, why, the impact and the validation run. Squash-merge.
- Conventional commit subjects: `type(scope): subject`.
- Planned HeOCR work with a notation (such as `E2d4`) uses the PR title `<notation>: <sentence-case summary>` and a
  `## Planning notation` section.

## Repository structure
- `src/worker/`: the Worker (router `index.ts`, handlers `api.ts`, queue, rate limits, D1 access).
- `src/worker/auth/`: identity providers (Google, dev-only), session cookie, reviewer pseudonym.
- `src/tasks/`: the generic model (`types.ts`, `export.ts`, `import.ts`, `rows.ts`) and one directory per task type.
- `src/tasks/reference_audit/schema.ts`: the TypeScript port of hocrgen's E2d4 validators. It is the contract and
  must stay in step with `hocrgen/src/hocrgen/reference_audit.py`.
- `src/web/`: the frontend (vanilla TypeScript, bundled by `scripts/build-web.mjs` into `public/app.js`).
- `src/shared/`: code used by both the Worker and the frontend (diff, visible characters, terms, API types).
- `scripts/`: import, export and deploy (Node, run with `tsx`).
- `migrations/`: D1 migrations. Add new numbered files; never edit an applied migration.

## Hard boundaries
- Never import anything from `HeOCR/heocr-restricted-eval` or any private source. Only openly licensed pages.
- Never store email addresses or identity-provider names. Reviewer ids are keyed pseudonyms (`rv_` + 8 hex).
- Never commit scan crops (`public/media/` is gitignored), credentials, `.dev.vars` or the secrets file.
- Never print or log the Cloudflare API token.
- Never set `DEV_AUTH_BYPASS` or `ENVIRONMENT=development` in `wrangler.jsonc`.
- No analytics and no third-party scripts beyond Google's sign-in script.
- An agent never writes decisions. Only human reviewers do, through the app.
- The export must produce exactly the consumer's format (for E2d4, hocrgen's `reference_audit_decisions.v1`). Change
  the format only together with the consumer.
- The contribution terms (`src/shared/terms.ts`) are a DRAFT until the maintainer approves them. Bump
  `TERMS_VERSION` on any change to the text.
- Deploy production only when the maintainer says so. Preview is `npm run deploy:preview`.

## Coding rules
- TypeScript strict. Keep the frontend dependency-free and small; it must stay fast on a phone.
- Hebrew is RTL. Isolate Latin and numbers that must not reorder (`<bdi>`), and test mixed text in the browser.
- Prefer fixture-backed, deterministic tests. Keep network calls out of tests.
