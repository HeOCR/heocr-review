# Held-out line proofreading

Use a `private-ref-proofread-*` batch for maintainer proofreading of a frozen reference. The standard `line_verify` screen serves a lossless, SHA-addressed PNG and the exact sealed text. It records Exact, Edit, or Unclear with a required note. Copy the print diplomatically and keep the benchmark's `[?]` notation. A recorded Unclear advances the queue and leaves the proposed replacement empty. The reviewer can go back and revise an answer while the queue is open.

This is a held-out test workflow. The restricted-reference reviewer secret identifies the sole reader and author, including on the Admin export. All media use the private R2 binding. All batch, region and line rows are marked test and non-trainable. Review text and notes never use the ordinary export, browser draft storage or offline resend storage. This queue has no volunteer allocation, pages to edit, assignment leases or additional migrations.

## Stage and read back

The authorized operator prepares a private UTF-8 manifest outside the checkout. Use schema `reference_proofread.v1`, the sealed LF reference SHA-256 in `reference_sha256`, and `rows` in reference order. For each row provide its leaf ID, 1-based region, 1-based leaf ordinal, 1-based global position, Boolean `hard`, exact `before`, and the crop's `crop_sha256`, `width`, and `height`. Each PNG is named `<sha256>.png` under the private crop root. The importer checks the complete reconstructed reference digest and each PNG's bytes and size. It orders all hard rows first and preserves registered reading order within each tier.

With a disposable local D1 and invented fixture data, use:

```sh
npx tsx scripts/import-reference-proofread.ts --dry-run \
  --batch private-ref-proofread-example --title 'Private reference proofreading' \
  --manifest "$manifest_file" --manifest-sha256 "$manifest_sha" --crop-root "$crop_root" \
  --media-out "$new_private_media_dir"
```

Omitting `--dry-run` stages a closed batch and checks D1 readback. Put fixture PNGs into the local protected R2 binding and open only the local fixture for UI tests.

Production requires lead GO. Use the deploy, private D1 backup, rollback and R2 denial checks in [Restricted reference review](restricted-reference-review.md). Verify the sole allowlisted reviewer is the intended maintainer. From clean merged main, upload the staged media directory to the approved protected bucket via the private single-part transfer. Then run the importer with `--target production --yes-production` and omit `--media-out` and `--dry-run`. It checks the account-wide budget, the private bucket settings and exact object inventory before D1 writes. If the budget guard refuses, keep the queue closed and wait for the next budget window. An existing batch ID also refuses a second import.

After closed-stage readback and the authorized Worker deployment, open only the staged batch with matching `restricted_reference=1`, `status='closed'`, test split and exact manifest SHA in `source_json`. Verify the named batch shows the pinned line count to the authorized reviewer and remains absent from other reviewer listings. Check signed-out denial without production test decisions. Close the batch before rolling back or sealing an export.

## Seal and hand off

The restricted reviewer uses Admin's export for the closed batch. The file contains one current answer per position in reference order, with the before and after strings and digests, action, note, crop digest and decision metadata. Check completeness and both the source and manifest pins locally. Seal with a manifest and payload SHA-256 within evaluation custody. The evaluation owner consumes the correction ledger in a reference amendment and re-scores the sealed predictions. The original reference and predictions remain immutable.
