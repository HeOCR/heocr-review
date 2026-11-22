# Registered phone captures

Eval intake and issuer-reference verification share one registered page roster. A capture belongs to a named view of a registered page. The reference queue has one issuer render and one line roster per page, with all phone views mapped to that page. Training has a separate intake roster and storage. Both upload forms are disabled in the shipped configuration.

## Eval handoff

Supply the registration receipt, the exact private roster bytes and their SHA-256. Check the pack hash and the registered page and slot totals against the receipt. The intake roster is JSON with these fields.

| Field | Contents |
| --- | --- |
| `schema` | `registered_phone_captures.v1` |
| `registration` | Reference to the approved registration receipt |
| `pack_sha256` | SHA-256 of the exact print pack |
| `batch_id` | Private verification batch ID starting with `private-ref-capture-` |
| `pages` | Registered pages in pack order |
| Page `page_id` | Stable uppercase ASCII page ID, with digits and hyphens permitted |
| Page `issuer_pdf_sha256`, `issuer_page_index`, `issue_key` | Exact issuer PDF hash, one-based source page index and registered issue group |
| Page `slots` | Ordered `A`, `B`, and, where assigned, `C` records, each with `slot` and `condition` |

Keep this payload, the print pack, any reference projection and all image assets outside Git and the static site bundle. The intake Worker verifies the exact roster hash at the private R2 key `registered-captures/v1/<roster-sha256>/roster.json`. An amended roster gets a new digest namespace. Do not silently copy old slots into a new roster.

## Private capture intake

With lead authorization and approved interface copy, configure `REGISTERED_CAPTURE_ROSTER_SHA256` to the verified digest and set `REGISTERED_CAPTURE_ENABLED=1`. Check the existing restricted bucket has no public endpoints and use the existing allowlisted reviewer session on the canonical host. The intake form is at `/registered-captures`. Verify signed-out access, other reviewers and alternate hosts are denied. Use invented fixtures on loopback before enabling collection.

Choose the registered page and slot for each unchanged camera file. The form suggests the next missing slot in roster order. Use original JPEG, PNG, or still HEIC/HEIF files up to 24 MiB. The uploader keeps the original filename as receipt metadata and checks the format from the bytes. The upload accepts more than one file and records device, camera mode, printer, paper, orientation, angle and lighting. A retake must name the current capture hash and provide a reason. A duplicate delivery of the current bytes returns the prior receipt. Reusing identical bytes for another slot is refused.

- Before upload, the browser shows a local preview and flags signs of soft focus or clipped coverage. Check text sharpness and all four corners yourself, and remove and retake any unusable photo. For formats the browser cannot preview, inspect the original in the photo app. The receipt displays the SHA-256 of the submitted original bytes.
- Originals live under `registered-captures/v1/<roster-sha256>/originals/<capture-sha256>`. They are archived unchanged, with no browser download route. Use authorized private bucket access for eval handoff.
- Each slot record at `registered-captures/v1/<roster-sha256>/slots/<page_id>/<slot>.json` lists the successful revisions and capture log in order. The final revision is the active original. Follow the slot record as the authority. If simultaneous uploads left an unreferenced original, keep it out of the freeze and reconcile it privately.
- Close intake before freezing by turning off the upload flag and allowing in-flight requests to finish. Keep the roster pin for reference verification. Eval reads back the expected slot records, hashes the raw bytes against their receipts and confirms the photographed page and assigned condition. Check full decode, privacy, framing and the retake log before freezing. HEIC/HEIF format detection during upload is a container check. Any sanitized derivative needs its own hash and lineage to the unchanged original.

## Private TRAIN capture intake

Use a separate private R2 bucket with public development URLs and custom domains disabled. Bind it to `TRAIN_CAPTURE_MEDIA`. After lead approval and approval of the interface copy, set `TRAIN_CAPTURE_ROSTER_SHA256` to the exact private runtime roster hash and `TRAIN_CAPTURE_ENABLED=1`. The form at `/registered-captures/train` uses the same canonical host and reviewer allowlist as eval. Intake fails closed if the TRAIN roster is visible in the restricted eval binding.

The TRAIN runtime roster is `train_phone_captures.v1` JSON with `pack_sha256`, `source_manifest_sha256` and `pages`. Project it from the pinned TRAIN source manifest. Each page has a `page_id` and ordered `slots` with `slot` and `condition`. Each page has `FLAT`, `OBLIQUE` and `DIM`, plus its optional registered `M-…` variant. Stage the roster at `train-phone-captures/v1/<roster-sha256>/roster.json` in the TRAIN bucket. Originals and slot receipts use the same relative layout as eval beneath that prefix.

Choose the page, capture condition and actual device A or B. The form suggests the next missing page and condition. This intake also supports DNG container detection and uses the same 24 MiB file limit. Each page and condition gets one photo regardless of device. The restricted bucket holds a digest-only scope claim so exact duplicates cannot land in both buckets. During private readback, verify each pictured page against the approved TRAIN source manifest before any training or calibration handoff. The selected page and file hash need to be checked against the pictured source.

## Office forms capture intake

The office form packs use the same private TRAIN bucket and separate digest namespaces under `train-form-captures/v1/<pack>/<roster-sha256>/`. Leave the eval and gazette routes bound to their original rosters. Each form roster uses schema `train_form_captures.v1` and binds the pack or blank digest index, source manifest, and issuer-reference hashes. Every page row binds its displayed ID, form ID, form-relative leaf, issuer PDF hash, one-based issuer page, and allowed slots.

| TRAIN pack | Form | Flag and roster pin | Selection |
| --- | --- | --- | --- |
| TRN-FM01 | `/registered-captures/train/fm01` | `FM01_CAPTURE_ENABLED`, `FM01_CAPTURE_ROSTER_SHA256` | Print page P01–P66 and its typed or handwritten slot |
| TRN-FM01-G | `/registered-captures/train/fm01-g` | `FM01_G_CAPTURE_ENABLED`, `FM01_G_CAPTURE_ROSTER_SHA256` | Form and leaf from the TYPED practice margin, then V1, V2, or V3 |

Stage each exact roster as `roster.json` in its own namespace. Keep all flags off while staging. The same allowlisted reviewer, original-byte receipts, retake checks, and photo quality prompts apply. The digest-only reservation refuses reuse of an original across packs. Use the matching pack in the metadata summary command below.

For TRN-FM01-G, match the visible practice margin and photographed page to the pinned issuer leaf. Transcribe the fields and boilerplate visible in the capture. Compare boilerplate against `source_boilerplate_native_lines` and any `source_boilerplate_raster` on that leaf, accounting for bidi and PDF line grouping. Keep the photographed wording and flag `boilerplate_drift` with the affected region and kind of change. Record the practice margin as provenance. Keep unreadable text pending review or retake. Hand off approved metadata-free working copies after consent, provenance checks, and digest-bound TRAIN CLEAN.

## Camera metadata and working copies

Ask every photographer to turn off camera location tagging before shooting. Preserve exact camera bytes, including any embedded EXIF. Keep eval originals in restricted storage and TRAIN originals in the private TRAIN store. Any original that still has GPS stays with those restricted originals. Upload receipts and serving routes expose no extracted EXIF. Operators can use a private scratch mirror for hash verification and should remove it after verified staging.

After closing intake, run `npx tsx scripts/capture-exif-summary.ts <eval|train|TRN-FM01|TRN-FM01-G> <private-bucket-mirror> <roster-sha256>` on the matching private roster and active slot receipts and originals. It verifies the active hashes and emits per-roster counts for device models, resolution, compression, EXIF and GPS presence. GPS values are never written. An unreadable image or malformed EXIF can leave GPS presence unknown. Keep per-photo intake and retake logs within the originals store.

Add `--working-copies` to generate oriented PNGs under the same scoped mirror's `working/` prefix. The output contains pixels and hash lineage only. It omits EXIF, XMP and all other ancillary PNG chunks. The wrapper reports counts for any image it could not decode. Unavailable copies remain pending a decoder that can produce metadata-free pixels. Give workers, scorers and reports only the aggregate metadata summary. Use the sanitized copies as image inputs, and keep eval copies restricted and TRAIN copies within the private TRAIN flow.

## Verify the issuer references

Openref prepares a separately pinned `line_verify_items.v1.2` projection from the registered issuer text layer and renders. Include `draft_basis: "issuer_text_layer"` at the top level. Include `image_role: "issuer_render"`, `issuer_pdf_sha256`, and `issuer_page_index` on each page. Use the exact registered page IDs and order, and the registered `issue_key` as `book_group`. Preserve line order, uncertainty flags and the page image and geometry pins. Eval verifies issuer equivalence and draft coverage before handing off the projection. Phone photos never supply this queue’s page or crop bytes.

Use the restricted importer with `--verify-drafts --capture-roster <private-roster> --capture-roster-sha256 <pin>` in addition to the batch, pinned items, page and line counts, and media-root flags. It checks both digests and all issuer locators and installs a closed first-pass roster. The existing private R2 stage and D1 budget check apply. The runtime requires the same roster pin, an open batch and the allowlisted reviewer. With page sweep enabled, open the authorized batch on desktop to compare the issuer scan and boxed drafts. Confirm or correct flagged lines individually before completing each page. If lines are missing, use the existing desktop workflow to box and transcribe them. Line-by-line verification remains available. The upload flag is independent of issuer review.

Completed decisions and completeness exports go privately back to eval under the existing restricted workflow.
