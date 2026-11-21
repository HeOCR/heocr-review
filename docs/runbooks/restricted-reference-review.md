# Restricted reference review

This path is for registered, private reference review. Stage the queue with local synthetic fixtures first. A
deployment that carries protected static media must be refused. Only the lead's deployment runbook can take this
path live.

## Worker binding and gate

The Worker binds the dedicated `heocr-review-protected` R2 bucket as `RESTRICTED_REFERENCE_MEDIA`.
Before deploying, verify that the bucket belongs to the HeOCR account, its `r2.dev` endpoint is disabled,
and its custom domain list is empty. Confirm that anonymous requests for a known fixture at both the disabled
managed hostname and the S3 API end with non-2xx responses. Follow redirects without credentials and stop if
either request reaches a 2xx response. Keep access through the authenticated Worker route, without signing URLs.
Set `RESTRICTED_REFERENCE_REVIEWER_ID` in the private Worker secrets file for the existing approved account.
Use the existing admin permission for export as well. Follow the
[Cloudflare R2 visibility documentation](https://developers.cloudflare.com/r2/buckets/public-buckets/).

A protected batch has `batches.restricted_reference=1`. Reserved private batch IDs are protected regardless of
that field. Install only its registered pages in `restricted_reference_pages`. Set `blind_allowed` solely for
registered blind pages and retain the `after_confirm` gate and same-page first-pass anchor. Use
`first_allowed=0` to keep a legacy anchor for the blind gate without serving first-pass work. A missing anchor
or eligible first-pass decision leaves the blind pass closed. Existing legacy rows,
assignments and decisions stay in place. Generic listings, progress, next, direct proposal IDs, mutations and
exports are filtered by the roster. Use the authenticated Admin route for protected queue exports. During an open blind pass, the paired first-pass routes and the protected
batch export remain blocked. Production serves protected requests only on `https://review.heocr.org`.

Store JPEG, PNG or WebP objects at `<batch-id>/<sha256>.<extension>`. Image refs in D1 contain
`{"source":"r2","key":"<sha256>.<extension>"}`. The client receives only authenticated routes:

- `GET /api/restricted-media/v1/proposals/<id>/crop` and `GET /api/restricted-media/v1/proposals/<id>/page`
  share the proposal gate.
- `GET /api/restricted-media/v1/batches/<batch-id>/pages/<id>` requires a registered page currently eligible
  for a completeness check or missing-line additions.
- Historic `/media/...` paths for protected batch names and the former private image API paths return 404 with
  `Cache-Control: no-store` on both Worker hostnames. The asset binding is never called for these requests.

### Purge-free serving cutover

`assets.run_worker_first: true` sends every path through the Worker, including aliases a static asset resolver
could normalize. `cache.enabled: false` disables Workers Cache, which could otherwise respond before the
Worker. The zone CDN cache is consulted when the Worker fetches onward. Retired protected paths return directly
and the new image routes read the private R2 binding directly. Successful image responses use `private, no-store`
and explicit CDN no-store headers. No query parameter, cache rule change, cache purge permission or R2 object
rewrite is needed. Previously downloaded copies are outside this cutover. Public static paths still delegate to
the asset binding and now incur a Worker invocation. See [request order](https://developers.cloudflare.com/cache/interaction-cloudflare-products/workers/),
[Worker-first static assets](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first), and
[Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/#disable-caching).

1. After the lead approves the cutover, fetch `origin/main` and use a clean checkout at the merged commit.
   Record that commit and the single currently deployed Worker version. Export production D1 to a fresh private
   file (mode 0600) before changing anything. Record its SHA-256, table counts and closed-batch roster counts.
2. With both queues held, verify the R2 binding, allowlisted reviewer, bucket visibility and anonymous denial
   described above. Verify `preview_urls: false` and that no other public route serves the old paths or versions.
   Carry forward the existing approved public assets. Sweep the upload tree for protected paths and hashes.
   Run `npx wrangler d1 migrations list DB --remote --env=` with the production credentials. The serving change
   adds no migrations. Stop if a migration is pending outside the approved deploy and D1 write budget.
3. Run `npx tsx scripts/deploy.ts production --yes-production` with the existing binding and secrets. Verify
   100% of traffic is on the new version and record the ID. Use both the production custom domain and its
   `workers.dev` hostname. Request the exact previously served protected URLs without a query string or request
   cache bypass header. Try GET and HEAD, including a request with `If-None-Match` when the old ETag is known.
   Require 404, `Cache-Control: no-store`, no redirect, no image response or 304, and no cache hit. Check the
   old private image API paths the same way. Verify an unaffected public asset still serves. Retain statuses
   and headers privately, without retaining response bodies.
4. Use synthetic fixtures to confirm that the new route admits only the allowlisted account on the canonical
   origin and respects roster, completeness and blind gates. On production, verify signed-out denial on both
   hostnames using dummy IDs, and recheck the anonymous R2 endpoints and authenticated fixture readback. Keep
   `preview_urls` disabled and run authenticated fixture tests locally. Recount D1 immediately after the deploy
   and reconcile independent live reviewer activity. The serving deploy and its probes add zero D1 row writes.
5. Record the live route receipt in place of the legacy purge receipt for activation. If any gate or readback
   differs, leave the queues closed. Close any opened restricted queue before a rollback and use only a version
   that still denies the retired paths. A rollback that could serve a protected legacy asset is out of scope.

Serve protected media only through the Worker. Keep unboxed legacy confirmations outside the new line queue.
For a completeness-only page, use a pinned page image and its verified covered boxes from the existing review,
or an eval-registered supplement. Store the boxes as `coverage_boxes_json` on the roster row, and mark the item
registered for the current import as in migration 0014. Preserve the original confirmation separately. The
completeness entry belongs to the same registered page ID. Before a reviewer checks it, the export has
`completeness: null`. A missing-lines answer requires a saved desktop addition before closing the check.

## Before activation

### Stage the restricted line projection

Use `npx tsx scripts/import-restricted-reference.ts` with the registered `--batch`, `--items` and `--items-sha256`,
`--plants` and `--plants-sha256`, original `--media-root`, and the registered counts in `--pages`, `--lines`,
`--plant-count` and `--separate-blind-pages`. The default run validates pins and source images, maps first-pass
lines and runs the plant planner. Its output contains counts and digests.

Add `--media-out` with a new private directory outside the checkout and source root to produce the
content-addressed page and crop objects and a small access fixture. Use the approved private R2 transfer path
and upload each object as a single part. Keep the prepared directory private. Before running with
`--target production --yes-production`, follow the private export and cutover approval steps below and deploy
the restricted Worker and migration from clean main. The production run checks the D1 write budget, bucket
visibility, anonymous denial on the provisioned fixture, every staged object key, length and single-part ETag.
It writes the first-pass roster, triage settings and ratified plants as one closed restricted batch. An existing
batch must already match the completed closed stage to be accepted on retry. Blind and coverage-only
registrations are staged separately.

### Draft verification

For a registered draft projection, pass `--verify-drafts` with the pinned `--items`, `--items-sha256`,
`--media-root` and registered counts in `--pages` and `--lines`. Use a `private-ref-` batch ID and the same
restricted staging and R2 checks. The projection uses `line_verify_items.v1.2` and an empty
`blind_second_pass` list. Each line is a first-pass `verify` item with an NFC candidate, an explicit
`uncertain` boolean, and provenance of `reference_draft` or `llm:<model>:<prompt sha256>`. The writer orders
uncertain lines first, preserving the registered rank order within each group. It stages a closed batch.

The allowlisted reviewer uses the line comparison screen and its correction diff. Completeness checks unlock
after every line has an Exact or edited decision on the current content. Skipped lines still need review.
Use the authenticated Admin export to retrieve `line_verify_decisions.json` for the line answers and
`reference_verification_pages.json` for explicit page answers and any added lines. A null `completeness`
value means the page is pending. Added-line boxes use page fractions.

### Page sweep for ratified issuer drafts

Use a `private-ref-draft-` batch ID for issuer drafts outside the phone capture roster. After eval ratification
and the closed-stage readback, add the exact batch ID and the importer's `--items-sha256` projection digest
to the `RATIFIED_ISSUER_SWEEP_PINS` JSON map in the private Worker configuration. For example, the map has the
shape `{"private-ref-draft-example":"<64 lowercase hex characters>"}`. Preserve existing entries when adding a
batch. Keep the source archive and its ratification pins in the private staging receipt. The registry uses the
digest of the imported items projection. A missing or mismatched entry denies even direct links and exports
for that batch.

With `PAGE_SWEEP_ENABLED=1` and the authorized batch open, desktop opens page sweep. The reviewer confirms or
corrects flagged lines individually before completing a page. The existing line comparison and missing-lines
editor stay available. The phone capture upload flag and its roster pin are independent of this registry.

Keep these batches closed through staging. Supply a counts-only receipt for the registered roster, active line
proposals, prior usable decisions, authorized blind passes, and completeness-only pages. Compare those counts to
the eval pins and verify that the excluded pages have no active queue path. Verify the staged media keys and
checksums against the private manifest, and scan the static bundle for all protected file paths and hashes.

Use the existing ratified plant import and retain its receipt. Check the expected live plant count and hash,
with zero skipped decisions and zero refusals. Test that an untouched planted line is masked even when its
direct URL is requested with the fix queue parameter.

Repeat the signed-out, other signed-in reviewer, other admin, approved reviewer, alternate Worker origin and
direct media checks. Verify the paired blind gates, approvals and initial no-store responses. Get the lead's
cutover review before opening. For an already staged queue, opening requires only the existing guarded status
update, subject to the D1 write budget. Keep the separately gated blind pages and legacy completeness item
separate. Recount and read back the status after opening. For a draft queue, wait for eval's pinned handoff,
then take a fresh private export and run its existing budget-checked import. Keep protected imports and any
temporary derivatives out of `public/`.
