# Training page transcription

`page_paste_train` is an admin-only task for transcribing entire pages from a training source. Sign in and open
`/app/#b/<batch_id>` on a phone or desktop. Zoom the scan and paste the transcription with the manuscript's line
breaks. The page counter and navigation buttons browse every page in bundle order. Skip and Save and next advance to the
next untranscribed page, wrapping around to earlier pages. Skipping writes no decision. The form compares the
number of detected boxes with the number of nonblank lines entered. A mismatch is saved with an alignment flag.
Empty scans can be saved with empty text.

Reopen a page to edit your saved transcription. A changed save archives the previous version in
`page_paste_train_history` and checks the revision to avoid overwriting edits from another tab. Exact retries
are safe. Progress and the alignment export use the latest saved version of each page.

## Datacol bundle contract

Supply an extracted directory containing `manifest.json` and `pages/`. Send the manifest SHA-256 separately.
Set the split to `train` and only include images cleared for training. Supply the exact openly licensed rights
URI supported by the importer (CC0, Public Domain Mark, CC BY or CC BY-SA). Follow the catalog evidence for each
source. This example illustrates the format:

```json
{
  "schema": "page_paste_train_manifest.v1",
  "task_type": "page_paste_train",
  "split": "train",
  "batch_id": "loc_2018757746_train",
  "title": "Prayers for the midnight service",
  "source": {
    "source_id": "loc_2018757746",
    "catalog_url": "https://www.loc.gov/item/2018757746/",
    "rights_uri": "https://creativecommons.org/publicdomain/mark/1.0/"
  },
  "pages": [
    {
      "page_id": "p0001",
      "image": {
        "path": "pages/p0001.jpg",
        "sha256": "<lowercase SHA-256 of the exact image file>",
        "width": 1300,
        "height": 2000
      },
      "line_boxes": [[80, 120, 1180, 188], [78, 204, 1190, 268]]
    }
  ]
}
```

- List every page, including covers and blanks, in the intended review order. Keep stable and unique page IDs.
- Each image is a full page in the same pixel frame used by the detector. Physically orient the pixels before
  detecting lines and hash the final image. Use single-frame JPEG, PNG or WebP, at most 8 MiB and 50 MP per image.
- List detected boxes in intended reading order as integer `[x0, y0, x1, y1]` rectangles with top-left origin and
  exclusive right/bottom edges. Use `[]` when no lines were detected. The importer preserves the box order and image bytes.
- Complete the evaluation removal for any page transitioning from test to training before the manuscript enters the
  training batch. The manifest identifies the split. The producer and lead confirm source clearance.

```sh
npm run import -- --task page_paste_train --bundle <dir> --manifest-sha256 <sha256> --target local --dry-run
npm run import -- --task page_paste_train --bundle <dir> --manifest-sha256 <sha256> --target local
```

To reserve a batch ID ahead of delivery, use `--init-empty --batch <id> --source-id <id> --title <title>`
instead of the bundle flags. The reservation has no pages and stays closed. The bundle must use the reserved batch
and source IDs to fill it.

The importer verifies manifest and image hashes, orientation, dimensions and boxes. It stages the batch closed with
private assets, checks every stored page and chunk count, and opens the batch after readback. If staging is
interrupted, repeat the same import with the same hash. Use a fresh batch ID for a different manifest.

## Export for alignment

Download `page_paste_train.json` from Admin or use
`npm run export -- --batch <batch_id> --out <private-dir> --target local`. The
`page_paste_train_transcriptions.v1` file includes the training split, manifest SHA-256, catalog and rights,
and each page's original image path/hash/dimensions and line boxes. The recorded decision holds full page text
(with CRLF/CR normalized to LF), the detected and entered counts, the mismatch flag, save timestamp, reviewer
pseudonym, and terms version. Unsaved pages have null decision fields. Use `image.sha256` to join the export to
the source bundle. The alignment step consumes the page text and detected boxes together.
