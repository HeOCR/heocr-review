# Restricted reference review

This path is for registered, private reference review. Stage the queue with local synthetic fixtures first. A
deployment that carries protected static media must be refused. Only the lead's deployment runbook can take this
path live.

## Worker binding and gate

Bind a dedicated R2 bucket as `RESTRICTED_REFERENCE_MEDIA` only after approval. Disable its `r2.dev` endpoint and
leave it without a public custom domain or any signing URL. Set `RESTRICTED_REFERENCE_REVIEWER_ID` as a Worker
secret for the approved account. Use the existing admin permission for export as well. Follow the
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

- `GET /api/proposals/<id>/image/crop` and `GET /api/proposals/<id>/image/page` share the proposal gate.
- `GET /api/batches/<batch-id>/pages/<id>/image` requires a registered page currently eligible for a completeness
  check or missing-line additions.
- Historic `/media/...` paths for protected batch names return 404. The static importer refuses those batches and
  deployment checks the asset tree. Remove protected bytes already served from legacy versions and invalidate
  cached URLs as part of the cutover. Check alternate Worker hostnames and storage hostnames independently.

Serve protected media only through the Worker. Keep unboxed legacy confirmations outside the new line queue.
For a completeness-only page, use a pinned page image and its verified covered boxes from the existing review,
or an eval-registered supplement. Store the boxes as `coverage_boxes_json` on the roster row, and mark the item
registered for the current import as in migration 0014. Preserve the original confirmation separately. The
completeness entry belongs to the same registered page ID. Before a reviewer checks it, the export has
`completeness: null`. A missing-lines answer requires a saved desktop addition before closing the check.

## Before activation

Keep these batches closed through staging. Supply a counts-only receipt for the registered roster, active line
proposals, prior usable decisions, authorized blind passes, and completeness-only pages. Compare those counts to
the eval pins and verify that the excluded pages have no active queue path. Verify the staged media keys and
checksums against the private manifest, and scan the static bundle for all protected file paths and hashes.

Use the existing ratified plant import and retain its receipt. Check the expected live plant count and hash,
with zero skipped decisions and zero refusals. Test that an untouched planted line is masked even when its
direct URL is requested with the fix queue parameter.

Repeat the signed-out, other signed-in reviewer, other admin, approved reviewer, alternate Worker origin and
direct media checks. Verify the paired blind gates, approvals and initial no-store responses. Get the lead's
cutover review before opening. Retain the private D1 export, its SHA and counts, the rollback target, Worker
version, and the post-change recount. Keep protected imports and any temporary derivatives out of `public/`.
