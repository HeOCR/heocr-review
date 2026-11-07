# HeOCR Review

A small online app where volunteers sign in and review correction proposals against real Hebrew page scans, for
the [HeOCR](https://github.com/HeOCR) open Hebrew OCR project.

The first task type is the **reference audit (E2d4)**. An agent audited 38 Hebrew Wikisource reference pages
against their scans and proposed 519 corrections (`reference_audit_proposals.v1` in
[hocrgen](https://github.com/HeOCR/hocrgen)). A human accepts, rejects or edits each proposal. The app exports
exactly the `reference_audit_decisions.v1` file that hocrgen applies. An agent proposal never changes a reference;
only human decisions do.

> **Contribution terms, terms of service and privacy policy: version `2026-11-07-v1`**, approved by the maintainer
> on 2026-11-07 ([record](docs/decisions/2026-11-07-terms-approved.md)). They are the consent text in
> [`src/shared/terms.ts`](src/shared/terms.ts) and the pages [`public/terms.html`](public/terms.html) and
> [`public/privacy.html`](public/privacy.html), each in Hebrew and English. Decisions and edited text are contributed
> under CC BY-SA 4.0, credited by pseudonym unless the volunteer opts in to a display name. Any change needs the
> maintainer's approval and a new version. Contact: heocrproject@gmail.com.

## How it works

- **One Cloudflare Worker** serves the static site and the API (`/api/*`). The public pages need no sign-in and
  no JavaScript: `/` (home), `/privacy` and `/terms`; these are the Google OAuth branding URLs. The review app is at
  `/app/`. **D1** stores
  reviewers, assignments and decisions. Scan crops are Worker static assets under `public/media/` (no R2); an
  `ImageRef` union (`src/shared/media.ts`) leaves room for another image source.
- **Data model:** task types → batches of items → proposals → decisions. A task type
  (`src/tasks/reference_audit/`) says how a proposal is shown, which decisions exist, how a decision is
  normalised, and how decisions are exported. Planned task types (Pinkas per-line language tags, Ben-Yehuda
  silver-page confirmation, quality-3 second-review adjudication) add a module in `src/tasks/` and, if needed, a
  view in `src/web/views/`.
- **Every decision is kept.** Several reviewers may decide one proposal. A reviewer's later decision supersedes
  their own earlier one, which stays in the history. A decision on proposal content that has since changed is stale
  and never exported.
- **Queue:** easiest and highest-confidence first (confidence, then category, then short spans). A proposal leaves
  the queue once it has `min_reviewers` decisions (1 for now). A short lease spreads concurrent reviewers.
- **Review screen:** the enlarged crop with the region outlined, zoom, and a full-page view. It shows the current
  and the proposed text with the changed letters marked and invisible characters shown (`␣`, `⍽`, `⟨RLM⟩`,
  presentation forms), plus code points, the category, the agent's confidence and its note. Buttons are Accept,
  Reject, Edit (prefilled with the proposal) and Skip. Desktop shortcuts are `A`, `R`, `E`, `S`, `B` (back), `+`/`−`
  and `P`; they work in a Hebrew keyboard layout too. On phones there is a large bottom action bar. Progress is
  shown throughout.

## Privacy

- Sign-in is Google Identity Services (ID-token flow, client id only, no client secret). The Worker verifies the
  token against Google's JWKS (signature, `iss`, `aud`, `exp`, `iat`) and uses only `sub`.
- The reviewer id is `rv_` + the first 8 hex digits of HMAC-SHA256(`REVIEWER_ID_SECRET`, `google:<sub>`). That is
  hocrgen's reviewer id format. No email address or Google name is stored.
- The session is the app's own signed cookie: `__Host-hr_session`, HttpOnly, Secure, SameSite=Lax, 14 days.
- A display name is stored only after explicit opt-in, with the date. Every consent and withdrawal is logged in
  `consent_events` with the terms version.
- There is no analytics and no third-party script except Google's sign-in script (see the CSP in `public/_headers`).
- The auth layer is swappable (`src/worker/auth/provider.ts`).

## Abuse limits

Writes need a session and a same-origin JSON request. Per-reviewer fixed-window limits apply: 60 decisions or skips
a minute and 3,000 a day, 300 reads a minute, and 20 sign-ins a minute per client (its address is stored only as a
keyed hash). Bodies are capped at 16 KB and edited text at 1,000 characters. Control characters and malformed
display names are refused.

## Develop

```sh
npm ci
cp .dev.vars.example .dev.vars        # ENVIRONMENT=development, DEV_AUTH_BYPASS=1, dev secrets
npm run db:migrate:local
npm run import -- --task reference_audit --bundle <app_bundle> --pages-dir <hires> --target local
npm run dev                            # http://localhost:8787/app/, with a "DEV sign-in" form
npm run lint && npm run typecheck && npm test
```

The dev sign-in works only when `ENVIRONMENT=development`, `DEV_AUTH_BYPASS=1` and the request host is loopback.
`wrangler.jsonc` sets `production`/`preview` and never the flag; a test and the deploy script both enforce this, and
wrangler never uploads `.dev.vars`.

Tests run the Worker in workerd with a local D1 (`@cloudflare/vitest-plugin`). They also run the exported decisions
through hocrgen's own validator (`python -m hocrgen.tools.reference_audit`). That needs a hocrgen checkout in
`HOCRGEN_DIR` (default `~/clones/hocrgen`); CI checks out `HeOCR/hocrgen` and makes the test mandatory.

## Proposals in

Only openly licensed pages may be imported: Wikisource scans and text are fine. The import script refuses
`heocr-restricted-eval` or any path or repository named like it, and a proposals file without an open
`text_license`.

1. In hocrgen (operator), write the bundle: the proposals, one crop per proposal, and `crops.json` with checksums.

   ```sh
   python -m hocrgen.tools.reference_audit --export-dir <app_bundle> --page-images <hires>
   ```

2. Here, import it. The script checks the schema and every checksum, places the crops in `public/media/`
   (gitignored), and upserts into D1. It never touches decisions.

   ```sh
   npm run import -- --task reference_audit --bundle <app_bundle> [--pages-dir <hires>] --target local|preview
   ```

   `--pages-dir` adds the full-page view. Without a bundle, `--proposals <file> --pages-dir <hires>` cuts the crops
   here.

3. For a remote target, redeploy so the crops are served: `npm run deploy:preview`.

## Decisions out

```sh
npm run export -- --batch e2d4_reference_audit_v1 --target preview --out out/
```

This writes `out/reference_audit_decisions.json`: exactly `reference_audit_decisions.v1`, with every reviewer's
current decision, `decision_id` `decision:<proposal_id>:<reviewer>`, `checked_by: human` and `decided_at`. hocrgen
applies a proposal when at least `min_reviewers` reviewers agree. It also writes
`out/reference_audit_decisions_ledger.json`, which holds every decision including superseded and stale ones, the
per-proposal outcome and `reviewer_count`, conflicts, and opted-in credits. The decisions file is validated before
it is written. Copy it over hocrgen's `docs/reference_audit_decisions.json` in a PR, then check it there:
`python -m hocrgen.tools.reference_audit`.

The admin can also download both files from the app (`/app/#admin`, *Export*).

## Deploy

Credentials live in `~/.config/heocr/cloudflare.env`: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_WORKERS_SUBDOMAIN` and `GOOGLE_OAUTH_CLIENT_ID`. They are never printed or committed.

```sh
npm run deploy:preview      # Worker heocr-review-preview + D1 heocr-review-preview
```

The deploy script:

- creates the D1 database if needed and records its id in `wrangler.jsonc`;
- applies migrations and builds the frontend;
- deploys with `GOOGLE_CLIENT_ID` as a var;
- reads the secrets from `~/.config/heocr/heocr-review-<env>.secrets.json` (mode 0600, generated on the first
  deploy): `SESSION_SECRET`, `REVIEWER_ID_SECRET` and `ADMIN_REVIEWER_IDS`. Back the file up: if
  `REVIEWER_ID_SECRET` changes, every reviewer gets a new id.

The admin is the maintainer's reviewer id, as `ADMIN_REVIEWER_IDS` in that file. It appears under *Settings* after
signing in; add it there and redeploy. The Google OAuth client must list the Worker's origin as an authorised
JavaScript origin. Its branding URLs are `<origin>/`, `<origin>/privacy` and `<origin>/terms`. Production (`heocr-review`) is deployed only on the maintainer's word:
`tsx scripts/deploy.ts production --yes-production`.

## Licence

Code: MIT. Contributed decisions and edited text: CC BY-SA 4.0.
