# HeOCR Review

A small online app where volunteers sign in and review correction proposals against real Hebrew page scans, for
the [HeOCR](https://github.com/HeOCR) open Hebrew OCR project.

Three task types:

- **Reference audit (E2d4).** An agent audited 38 Hebrew Wikisource reference pages against their scans and
  proposed 519 corrections (`reference_audit_proposals.v1` in [hocrgen](https://github.com/HeOCR/hocrgen)). A human
  accepts, rejects or edits each proposal. The app exports exactly the `reference_audit_decisions.v1` file that
  hocrgen applies. An agent proposal never changes a reference; only human decisions do.
- **Line verification.** A human looks at one printed line on a real scan and a candidate transcription of it written
  by a different human (a Wikisource quality-3 proofreader, or Project Ben-Yehuda text aligned to an NLI free-use
  scan), and marks it exact, corrects it, or marks it unreadable or misaligned. When the letters match but the print
  is pointed and the candidate is not, it marks "print has niqqud" (`pointed_print`), optionally with the letters
  corrected and no niqqud typed. hocrgen exports the `line_verify_items.v1` bundle; the app exports
  `line_verify_decisions.v1.1` (v1 plus `pointed_print`), and hocrgen's attestation policy decides
  what a verified line becomes. The contract is HeOCR planning's
  `tasks/real-source-mapping/outputs/line_verify_contract.md`; `src/tasks/line_verify/schema.ts` implements it.
- **Page review.** A human reads one whole printed page next to a pre-filled transcription of it (the PDF's own OCR
  layer, or stock Tesseract; never a HeOCR model), corrects it line by line (edit, print has niqqud, not on the page,
  unreadable, merge, split, move, add) and confirms that the lines, as corrected, are the page's text in reading
  order, or rejects the page with a reason. Lines flagged tier A ("look here": letters that disagree with an
  independent reading, or digits and brackets) must each be looked at before the page can be confirmed; a flag never
  proposes a correction. A typing-conventions sheet is shown on the screen. Reserve pages open only to replace a
  rejected page (same stratum first), and a blind second pass of a page opens to a reviewer 24 hours after their own
  first-pass confirm, from a different pre-fill and without their first answers. heocr-eval's batch manifest
  (`heocr_midcentury_batch.v0`, plus `blind_prefill.json`) comes in; `page_review_decisions.v0` goes out. The spec is
  HeOCR planning's `tasks/eval-domains/capture/midcentury/REVIEW_BATCH_SPEC.md`; `src/tasks/page_review/schema.ts`
  implements it.

When more than one batch is open, the app starts with a task picker (`/app/#b/<batch id>` opens one).

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
  (`src/tasks/reference_audit/`, `src/tasks/line_verify/`) says how a proposal is shown, which decisions exist, how a
  decision is normalised, and how decisions are exported. For line verification a bundle page is an item and a line
  is a proposal (`category` = stratum, `confidence` = candidate provenance). Planned task types (Pinkas per-line
  language tags, quality-3 second-review adjudication) add a module in `src/tasks/` and, if needed, a view in
  `src/web/views/`.
- **Every decision is kept.** Several reviewers may decide one proposal. A reviewer's later decision supersedes
  their own earlier one, which stays in the history. A decision on proposal content that has since changed is stale
  and never exported.
- **Queue:** most informative first. Reference audit: by category (letter confusion, extra text, missing text, word
  join/split, editors' text not in print, then punctuation, and spacing last, since hocrgen now fixes "space before
  punctuation" by rule), and within a category lower agent confidence first. Line verification: the bundle's `rank`
  (hard lines first), ties by `item_id`. A re-import updates the order. A proposal leaves the queue once it has
  `min_reviewers` decisions (1 for now). A short lease spreads concurrent reviewers.
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

3. For a remote target, redeploy so the crops are served: `npm run deploy:preview`. A deploy uploads exactly what is
   in `public/media/`, so copy in the media of every batch the target serves before deploying.

### Line verification bundles

```sh
npm run import -- --task line_verify --bundle <dir with items.json and pages/> --target local|preview
```

The script validates `items.json` (`line_verify_items.v1`: open `text_license`, an attribution, boxes inside the
page, NFC single-line candidates, attention spans as code-point offsets, a URL-safe `batch_id`), checks every page
image's SHA-256 and aspect ratio, and cuts with `sharp`, per line, one JPEG of its context band (the union of `box`
and `context_box` plus a little air, at the scan's resolution up to 1,800 px wide, quality 85) and, per page, a
reduced 1,000 px page. The browser cuts the large line view from the context crop, so there is one file per line.
It prints the batch's `media_files`, `media_mb` and largest file. For about 1,500 lines over a few hundred pages
that is roughly 1,500 + pages ≈ 2,000 files and, at 50-150 KB a crop, about 100-250 MB: well inside the Workers
static-asset limits (20,000 files per version on the free plan, 25 MiB a file) and far lighter for a phone than
shipping full-resolution pages. A decision is pinned to the line's text, boxes and page image: if a re-export changes
any of them, earlier decisions on that line become stale (kept, never exported).

A synthetic bundle for trying it out is `test/fixtures/line_verify/` (drawn by
`npx tsx scripts/dev/make-line-verify-fixture.ts`; made-up text, no real scan).

### Page review batches

```sh
npm run import -- --task page_review --bundle <dir with batch_manifest.json, pages/ and blind_prefill.json> --target local|preview
```

The script validates the manifest (pages, roles, flags on non-blank pre-fill lines, unique pages and image names)
and the optional `blind_prefill.json` (only pages the manifest marks `blind_second_pass`, the same image, a pre-fill
different from the first pass's, and `manifest_sha256` equal to the manifest file's SHA-256), checks every page
image's SHA-256, and writes each page once, whole, as a 16-level greyscale PNG up to 2,000 px wide (about 150 KB a
page; re-encoding drops all image metadata). The queue is the test pages in the manifest's order (eval's hardest
first), then the reserves, then the blind second pass; the last two are gated (`migrations/0002_proposal_gates.sql`).
A decision is pinned to the page's image, pre-fill and flags. Unsaved corrections stay in memory while the app is
open (nothing is kept in browser storage).

## Decisions out

```sh
npm run export -- --batch e2d4_reference_audit_v1 --target preview --out out/
```

This writes `out/reference_audit_decisions.json`: exactly `reference_audit_decisions.v1`, with every reviewer's
current decision, `decision_id` `decision:<proposal_id>:<reviewer>`, `checked_by: human` and `decided_at`. hocrgen
applies a proposal when at least `min_reviewers` reviewers agree. It also writes
`out/reference_audit_decisions_ledger.json`, which holds every decision including superseded and stale ones, the
per-proposal outcome and `reviewer_count`, conflicts, and opted-in credits. The decisions file is validated before
it is written. **Never copy it over** hocrgen's `docs/reference_audit_decisions.json`: that file also holds E2d4b
rule decisions (`checked_by: rule`, `reference_audit_decisions.v2`) and hocrgen's current description, which this
export lacks, so an overwrite would drop them. Merge it in a hocrgen PR instead, which keeps both and fails closed
on a decision id recorded with different content:
`python -m hocrgen.tools.reference_audit --decisions docs/reference_audit_decisions.json --add-decisions <export>/reference_audit_decisions.json`,
then check it there with `python -m hocrgen.tools.reference_audit`.

For a line verification batch the same command writes `out/line_verify_decisions.json` (`line_verify_decisions.v1.1`:
`decision_id` `decision:<item_id>:<reviewer>`, `exact` / `edited` (with the full corrected line, NFC) /
`unreadable` / `misaligned` / `pointed_print` (with the corrected letters as `text` only when they changed; niqqud
is refused), `decided_at`, `checked_by: human`) and its ledger. The server refuses an edit that is
empty, has a line break or control character, or is too long; it stores an edit as NFC without leading or trailing
whitespace, and an edit equal to the candidate as `exact`. Each decision also carries `candidate_sha256`, the
SHA-256 of the UTF-8 candidate text the reviewer judged. That field is an addition to the v1 contract: an `exact`
names no text, so without it hocrgen could not tell that a decision was made on an earlier candidate.

For a page review batch it writes `out/page_review_decisions.json` (`page_review_decisions.v0`): one record per page
pass and reviewer, `decision_id` `decision:<unit_id>#p<page>[@pass2]:<reviewer>`, `pass` and `blind_second_pass`,
`prefill_source` and `prefill_sha256` of the pre-fill shown, `page_action` (`confirm`, or `reject` with
`reject_reason` and `reject_note` and `lines: []`), `reading_order_verified`, `lines` in the page's final reading
order (`i_src`: indices into the pre-fill's lines, blank lines counted; `action`; `text`, NFC as typed, null when
excluded; `reference_views`, `["consonantal"]` for `print_has_niqqud`), `counts`, `decided_at` and
`first_decided_at` (full ISO timestamps: eval checks the 24-hour gap between passes) and `checked_by: human`.

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
- reads the secrets from `~/.config/heocr/<worker>.secrets.json` (`heocr-review-preview.secrets.json`, `heocr-review.secrets.json`) (mode 0600, generated on the first
  deploy): `SESSION_SECRET`, `REVIEWER_ID_SECRET` and `ADMIN_REVIEWER_IDS`. Back the file up: if
  `REVIEWER_ID_SECRET` changes, every reviewer gets a new id.

The admin is the maintainer's reviewer id, as `ADMIN_REVIEWER_IDS` in that file. It appears under *Settings* after
signing in; add it there and redeploy. The Google OAuth client must list the Worker's origin as an authorised
JavaScript origin. Its branding URLs are `<origin>/`, `<origin>/privacy` and `<origin>/terms`. Production (`heocr-review`) is deployed only on the maintainer's word:
`tsx scripts/deploy.ts production --yes-production`.

## Licence

Code: MIT. Contributed decisions and edited text: CC BY-SA 4.0.
