# Held-out line proofreading

Use a `private-ref-proofread-*` batch for maintainer proofreading of a frozen reference. The standard `line_verify` screen serves a lossless, SHA-addressed PNG and the exact sealed text. It records Confirm, Correct, Unclear with a note, and Not in image. Copy the print diplomatically and keep the benchmark's `[?]` notation. Unclear and Not in image record a mask and advance the queue. For a missing line, open the separate region view, draw one box and type one line. This assigns a fresh ID and inserts the new line by the box's position in the registered region. A mis-split can be marked Unclear and the missing text added as its own line. The reviewer can revise answers and remove their additions while the queue is open.

This is a held-out test workflow. The restricted-reference reviewer secret identifies the sole reader and author, including on the Admin export. All media use the private R2 binding. The line response carries just the pinned crop and current reference, alongside workflow controls. The region view provides only the pinned region image and the reviewer's own additions. All batch, region and line rows are marked test and non-trainable. Review text and notes never use the ordinary export, browser draft storage or offline resend storage. The queue uses the existing restricted roster and added-line table without assignment leases or additional migrations.

## Stage and read back

The authorized operator prepares a private UTF-8 manifest outside the checkout. Use schema `reference_proofread.v2`, the sealed LF reference SHA-256 in `reference_sha256`, and `rows` in reference order. For each row provide its leaf ID, 1-based region, 1-based leaf ordinal, 1-based global position, Boolean `hard`, exact `before`, and the crop's `crop_sha256`, `width`, and `height`. Each row carries the sealed `region_sha256` and its integer `box` in that region’s native pixels. Each `regions` entry contains `leaf`, `region`, `sha256`, `width`, and `height`. Each PNG is named `<sha256>.png` under the private crop root. The importer checks the complete reconstructed reference digest and each PNG's bytes and size, then compares every decoded crop pixel against its exact sealed region slice. It orders all hard rows first and preserves registered reading order within each tier.

With a disposable local D1 and invented fixture data, use:

```sh
npx tsx scripts/import-reference-proofread.ts --dry-run \
  --batch private-ref-proofread-example --title 'Private reference proofreading' \
  --manifest "$manifest_file" --manifest-sha256 "$manifest_sha" --crop-root "$crop_root" \
  --media-out "$new_private_media_dir"
```

Omitting `--dry-run` stages a closed batch and checks D1 readback. Put fixture PNGs into the local protected R2 binding and open only the local fixture for UI tests.

Production requires lead GO. Use the deploy, private D1 backup, rollback and R2 denial checks in [Restricted reference review](restricted-reference-review.md). Verify the sole allowlisted reviewer is the intended maintainer. From clean merged main, upload the staged media directory to the approved protected bucket via the private single-part transfer. Then run the importer with `--target production --yes-production` and omit `--media-out` and `--dry-run`. It checks the account-wide budget, the private bucket settings and exact crop and region inventory before D1 writes. If the budget guard refuses, keep the queue closed and wait for the next budget window. An existing batch ID also refuses a second import.

After closed-stage readback and the authorized Worker deployment, open only the staged batch with matching `restricted_reference=1`, `status='closed'`, test split and exact manifest SHA in `source_json`. Verify the named batch shows the pinned line count to the authorized reviewer and remains absent from other reviewer listings. Check signed-out denial without production test decisions. Close the batch before rolling back or sealing an export.

## Seal and hand off

The restricted reviewer uses Admin's export for the closed batch. The file contains one current answer per position with the before and after strings and digests, action, mask state, note, crop digest and decision metadata. A mask serializes as `[?]` with its digest. Added lines have a fresh ID, null before and before digest, and carry their region hash, box and insertion slot. Check completeness and both source and manifest pins. Send the private JSONL with counts and digests to the assigned sealing custodian. For C2 amendment 11, evalcheck2 seals the text and the line join. Send heocr-eval counts and digests only. Use the sealed predictions for the re-score.
