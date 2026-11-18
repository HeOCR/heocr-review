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
  Items v1.1 (data-collection's old-print eval hold-out, 2026-11-18) adds candidates from published edition text
  (Sefaria, Project Gutenberg, Ben-Yehuda, Wikisource; never OCR), the page's script (square or Rashi), the agent
  pre-check's "look here" (a reason, never a text; a flagged line cannot be marked exact before the full page is
  opened) and a blind second pass for listed lines, gated as in page review below. The blind pass is typed from a
  blank box (heocr-eval: showing the candidate again would reproduce the very bias the pass measures): the candidate,
  its marks and the pre-check never reach the browser, and the typed answer is final. It opens 24 hours after a text
  answer on pass 1 (exact, edited or print has niqqud); by the batch's `pass2_reviewer` setting, to the same reviewer
  (`same`, the default) or only to a reviewer who never decided the line's pass 1 (`other`, for once volunteers
  review). While it is open and undecided, the reviewer's pass-1 line is closed to them. A v1.1 batch exports
  `line_verify_decisions.v1.2`: a header with the batch's `pass2_reviewer` mode (and when it was set) and the
  `blind_second_pass` list's count and sha256 (of its item ids, sorted, joined by newlines); each decision's `pass`; on pass 2 the decision `typed` (or `pointed_print` with the
  letters, `unreadable`, `misaligned`) and `same_reviewer`; on a blind line's pass 1 revised after pass 2,
  `revised_after_pass2` and the pass-1 answer that stood then.
  Items v1.2 (heocr-eval's P-hist page rule: every segmenter line of a scored page gets a reference) adds `kind`
  "type": a line with no candidate, typed from the same blank box on pass 1 (running heads, page numbers, catchwords
  and glosses too), with H's box problems (not one line, no text, continued). Each page names its `segmenter`,
  `kraken_lines` and `book_group`, and the import refuses a page whose items do not cover line_index
  0..kraken_lines-1 exactly once. One typing is a typed line's reference; a batch setting can require two independent
  typings for a book group's typed lines (eval's registered fallback). A v1.2 batch exports
  `line_verify_decisions.v1.3`: v1.2 plus each decision's `kind`, `box_reason` on a typed line's not_on_page, the
  two-typings setting, and `pages` (per page: kraken_lines, resolved lines, done, unreadable lines). A batch set to
  `resolution: volunteer_v1` (the P-hist test batches) follows `docs/specs/line_verify_volunteer_resolution_v1.md`:
  decisions count only from reviewers with mid-century standing, every line needs two counted decisions that agree
  under line_fold_v1, disagreements go to a third reviewer, then the maintainer (or a fourth volunteer if he decided
  the line), decisions are final, and the export is `line_verify_decisions.v1.4`. On a v1.2 verify
  line, misaligned (the candidate is not this line) opens a blank box: the decision carries the line as typed, so
  every line still gets a text, and the misaligned count measures the aligner (heocr-eval).
- **Page review.** A human reads one whole printed page next to a pre-filled transcription of it (the PDF's own OCR
  layer, or stock Tesseract; never a HeOCR model), corrects it line by line (edit, print has niqqud, not on the page,
  unreadable, merge, split, move, add) and confirms that the lines, as corrected, are the page's text in reading
  order, or rejects the page with a reason. Lines flagged tier A ("look here": letters that disagree with an
  independent reading, or digits and brackets) must each be looked at before the page can be confirmed; a flag never
  proposes a correction. A typing-conventions sheet is shown on the screen. Reserve pages open only to replace a
  rejected page (same stratum first), and a blind second pass of a page opens to a reviewer 24 hours after their own
  first-pass confirm, from a different pre-fill and without their first answers; while it is open and undecided,
  their first-pass page is closed to them (no view, no change). The blind pass's lines are flagged by the digit or
  bracket rule only: its pre-fill has no independent reading to disagree with, so its measured error is that of a
  second pass without letter-disagreement flags. First-pass pages can also carry Claude's hints (`ai_flags.json`, from
  heocr-lead): lines where Claude's own reading of the scan differs from the pre-fill, and lines next to which the
  page has text the pre-fill lacks (a margin note, say). They must be looked at like tier A, but a hint is only
  where to look: Claude's text is never shown, offered or pre-filled, and the blind pass never has hints. heocr-eval's
  batch manifest (`heocr_midcentury_batch.v0`, plus `blind_prefill.json`) comes in; `page_review_decisions.v0` goes out. The spec is
  HeOCR planning's `tasks/eval-domains/capture/midcentury/REVIEW_BATCH_SPEC.md`; `src/tasks/page_review/schema.ts`
  implements it.

When more than one batch is open, the app starts with a task picker (`/app/#b/<batch id>` opens one).

> **Contribution terms and terms of service: version `2026-11-12-v1`; privacy policy: version `2026-11-18-v3`**,
> approved by the maintainer on 2026-11-07 ([record](docs/decisions/2026-11-07-terms-approved.md)), changed to CC0
> on 2026-11-12 ([record](docs/decisions/2026-11-12-cc0.md)), and the privacy policy extended to unsaved page
> corrections on 2026-11-16 ([record](docs/decisions/2026-11-16-drafts-privacy.md)) and to what a deletion on request
> does with unpublished decisions the same day ([record](docs/decisions/2026-11-16-reviewer-deletion.md)), and to check
> lines in the volunteer line review on 2026-11-18 ([record](docs/decisions/2026-11-18-check-lines.md)). They are the consent text in
> [`src/shared/terms.ts`](src/shared/terms.ts) and the pages [`public/terms.html`](public/terms.html) and
> [`public/privacy.html`](public/privacy.html), each in Hebrew and English. Decisions and edited text are dedicated
> to the public domain under CC0 1.0 (the volunteer's own contribution; text they start from keeps its own licence),
> credited by pseudonym unless the volunteer opts in to a display name. Any change needs the
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
display names are refused. Volunteer lines fall under the same per-reviewer limits. A line can be decided only by a
reviewer it was served to, and only once. An admin can exclude a reviewer from agreement in a batch (their decisions are
kept, never counted) or block the account.

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

The script validates `items.json` (`line_verify_items.v1` or `.v1.1`: an open `text_license` (CC0, public domain,
CC BY or CC BY-SA; NonCommercial and NoDerivatives are refused), an attribution, boxes inside the
page, NFC single-line candidates, attention spans as code-point offsets, a URL-safe `batch_id`), checks every page
image's SHA-256 and aspect ratio, and cuts with `sharp`, per line, one JPEG of its context band (the union of `box`
and `context_box` plus a little air, at the scan's resolution up to 1,800 px wide, quality 85) and, per page, a
reduced 1,000 px page. The browser cuts the large line view from the context crop, so there is one file per line.
It prints the batch's `media_files`, `media_mb` and largest file. For about 1,500 lines over a few hundred pages
that is roughly 1,500 + pages ≈ 2,000 files and, at 50-150 KB a crop, about 100-250 MB: well inside the Workers
static-asset limits (20,000 files per version on the free plan, 25 MiB a file) and far lighter for a phone than
shipping full-resolution pages. A decision is pinned to the line's text, boxes and page image: if a re-export changes
any of them, earlier decisions on that line become stale (kept, never exported).

Batch settings, which a re-import keeps (`migrations/0006_batch_settings.sql`):

```sh
npm run batch-setting -- --batch <id> --target local|preview|production                       # read
npm run batch-setting -- --batch <id> --pass2-reviewer other --by <who> --target preview       # change
npm run batch-setting -- --batch <id> --two-typings-groups early --by <who> --target preview   # v1.2: two typings ("none" clears)
npm run batch-setting -- --batch <id> --resolution volunteer_v1 --by <who> --target preview    # before the first decision
```

A synthetic bundle for trying it out is `test/fixtures/line_verify/` (drawn by
`npx tsx scripts/dev/make-line-verify-fixture.ts`; made-up text, no real scan). `test/fixtures/line_verify_v11/` is
the same lines as a v1.1 file, for the Worker tests only (it ships no page images).

### Page review batches

```sh
npm run import -- --task page_review --bundle <dir with batch_manifest.json, pages/, blind_prefill.json and ai_flags.json> --target local|preview
```

The script validates the manifest (pages, roles, flags on non-blank pre-fill lines, unique pages and image names)
and the optional `blind_prefill.json` (only pages the manifest marks `blind_second_pass`, the same image, a pre-fill
different from the first pass's, and `manifest_sha256` equal to the manifest file's SHA-256), checks every page
image's SHA-256, and writes each page once, whole, as a 16-level greyscale PNG up to 2,000 px wide (about 150 KB a
page; re-encoding drops all image metadata). The queue is the test pages in the manifest's order (eval's hardest
first), then the reserves, then the blind second pass; the last two are gated (`migrations/0002_proposal_gates.sql`).
A decision is pinned to the page's image, pre-fill and flags.

The optional `ai_flags.json` (`heocr_midcentury_ai_flags.v0`: `batch_id`, `model`, `created_at`, `manifest_sha256`,
and per page `unit_id`, `page`, `flagged_i`, `missing_near_i`) names manifest pages, so first-pass pages only, and
only shown (non-blank) line indices. The hints are not part of a page's content hash, so importing them, or
changing them, keeps every earlier decision current; each decision records instead the hints its reviewer was
shown (the browser sends their hash back; none for a page opened before they were imported). Unsaved corrections are saved on the server as a
draft (`migrations/0004_drafts.sql`; `PUT`/`DELETE /api/proposals/<id>/draft`): after a pause in typing, and at once
when a line is left, with a status line (נשמר / שומר… / שמירה נכשלה, מנסה שוב) and retries. Opening the page again,
after a reload or on another device, restores it: the reviewer's own decision first, then the draft, then the
pre-fill. A draft is per reviewer and page, pinned to the pre-fill it was made on (one made on another pre-fill is
refused, and deleted when found); it is never exported, never counted in progress, and confirming or rejecting the
page deletes it. Nothing is kept in browser storage. Decision and draft requests may be up to 512 KB (a whole page's
lines); other writes stay at 16 KB.

### Subsets (a filter in the app)

```sh
npm run import-subset -- --file <interim_v1.json> --batch newprinted_midcentury_v0 --target local|preview
```

A subset is a named set of a batch's pages that a reviewer can work through on its own: the batch header offers
"כל העמודים" (all pages) and each subset (`#b/<batch>/s/<subset id>`; the id is the file name without `.json`). The
file is eval's interim set (`heocr_midcentury_interim.v1`): per stratum a pick and ordered alternates, named by
proposal `external_id`. Its sha256 must be the registered one (`REGISTERED_SHA256` in `scripts/lib/subset.ts`, from
heocr-restricted-eval's preregistration `SHA256SUMS`), its `manifest_sha256` the batch's, and every member an active,
ungated proposal of the batch. In the filter, each stratum serves its pick; once the pick has a current rejection (or a
confirm with every line excluded, which leaves no reference line), it serves the first alternate still standing. The
queue serves those pages in rank order, and progress counts strata. Only the subset tables change
(`migrations/0003_subsets.sql`): proposals, content hashes, decisions and exports are untouched, and decisions made in
the filter are ordinary decisions on the same proposals.

### Volunteer line review (preview only)

```sh
npm run maintainer-decided -- --out <bundle dir> --target production --yes-production   # read-only: page keys only
npm run import -- --task line_consensus --bundle <bundle dir> --target local|preview
```

Community volunteers review the mid-century pages one printed line at a time (task type `line_consensus`; maintainer's
decision and eval's amendment of 2026-11-18, heocr-restricted-eval `preregistration/midcentury_volunteers_2026-11-18`).
The bundle holds eval's registered `line_items_v1.json` and `volunteer_exclusions_v1.json` (their sha256 must be the
registered ones, `REGISTERED_SHA256` in `src/tasks/line_consensus/schema.ts`), `maintainer_decided.json` (the pages the
maintainer had decided, which keep his references), the batch's `ai_flags.json`, `pages/` and, once registered,
`gold_v1.json`.

- **Routing:** every line with a box goes to two volunteers who never see each other's decision. A disagreement sends
  that line alone to a third. Three different answers send it to the maintainer, who gets it from the pre-fill only.
  Lines with no box go straight to the maintainer.
- **Agreement:** eval's `agreement.py`, ported in `src/tasks/line_consensus/consensus.ts` and tested on its cases.
- **Gold lines:** come from pages volunteers are never given. One in 10 over a volunteer's first 100 lines, then one
  in 20, at a point seeded by `sha256("gold|" + reviewer_id)`, each at most once.
- **Who counts:** a volunteer's decisions count once they have 20 gold lines at 95% or better, past ones included.
  Below that, or excluded by an admin's switch, none count and their lines reopen.
- **Final decisions:** a decision is final, and the progress shown counts only the volunteer's own lines.
- **The browser cuts each line** from the page image, so there is no file per line.
- **The export** is `line_consensus_decisions.v0`, which eval's ingest recomputes with `agreement.py`.
- **The maintainer's own queue:** once a volunteer batch has a page, the maintainer's page review leaves it out of
  "all pages", so the two sets of references never overlap. A filter that names it (the blind audit) still serves it.
  The interim pages, which supply the gold lines, stay his.
- **Off unless switched on:** the whole task is off unless `CONSENSUS_ENABLED=1` (set for preview in
  `wrangler.jsonc`), until the maintainer approves the privacy text for gold lines and accuracy.

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
excluded; `reference_views`, `["consonantal"]` for `print_has_niqqud`), `ai_flagged_i` and `ai_missing_near_i`
(Claude's hints the decision was made with, as line indices; null when none were shown, which is always so on the
blind pass and for decisions made before hints were imported), `counts`, `decided_at` and
`first_decided_at` (full ISO timestamps: eval checks the 24-hour gap between passes) and `checked_by: human`. A
pass-1 record of a page whose blind pass the same reviewer decided also has `revised_after_pass2`: true when that
pass-1 decision was made after their first pass-2 decision, and then `pass1_at_pass2`, the pass-1 decision that
stood at that moment (its page action, lines, hints shown and `decided_at`), which is the one the two passes compare.

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

Code: MIT. Contributed decisions and edited text: CC0 1.0 (since terms `2026-11-12-v1`; decisions under
`2026-11-07-v1` were CC BY-SA 4.0, except the maintainer's own, which he released under CC0 1.0:
[record](docs/decisions/2026-11-12-cc0.md)). Each exported decision's `terms_version` is in the ledger.
