# Registered phone captures

Intake and issuer-reference verification share one eval-registered page roster. A capture belongs to a named view of a registered page. The reference queue has one issuer render and one line roster per page, with all phone views mapped to that page. The upload form is disabled in the shipped configuration.

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

Name each original `<page_id>-<slot>.<extension>`. Use original camera files in JPEG, PNG, or still HEIC/HEIF, up to 24 MiB each. On mobile, use a file picker that preserves the renamed original file and its bytes. The upload accepts more than one file and records device, camera mode, printer, paper, orientation, angle and lighting. A retake must name the current capture hash and provide a reason. A duplicate delivery of the current bytes returns the prior receipt. Reusing identical bytes for another slot is refused.

- Originals live under `registered-captures/v1/<roster-sha256>/originals/<capture-sha256>`. They are archived unchanged, with no browser download route. Use authorized private bucket access for eval handoff.
- Each slot record at `registered-captures/v1/<roster-sha256>/slots/<page_id>/<slot>.json` lists the successful revisions and capture log in order. The final revision is the active original. Follow the slot record as the authority. If simultaneous uploads left an unreferenced original, keep it out of the freeze and reconcile it privately.
- Close intake before freezing by turning off the upload flag and allowing in-flight requests to finish. Keep the roster pin for reference verification. Eval reads back the expected slot records, hashes the raw bytes against their receipts and confirms the photographed page and assigned condition. Check full decode, privacy, framing and the retake log before freezing. HEIC/HEIF format detection during upload is a container check. Any sanitized derivative needs its own hash and lineage to the unchanged original.

## Verify the issuer references

Openref prepares a separately pinned `line_verify_items.v1.2` projection from the registered issuer text layer and renders. Include `draft_basis: "issuer_text_layer"` at the top level. Include `image_role: "issuer_render"`, `issuer_pdf_sha256`, and `issuer_page_index` on each page. Use the exact registered page IDs and order, and the registered `issue_key` as `book_group`. Preserve line order, uncertainty flags and the page image and geometry pins. Eval verifies issuer equivalence and draft coverage before handing off the projection. Phone photos never supply this queue’s page or crop bytes.

Use the restricted importer with `--verify-drafts --capture-roster <private-roster> --capture-roster-sha256 <pin>` in addition to the batch, pinned items, page and line counts, and media-root flags. It checks both digests and all issuer locators and installs a closed first-pass roster. The existing private R2 stage and D1 budget check apply. The runtime requires the same roster pin, an open batch and the allowlisted reviewer. With page sweep enabled, open the authorized batch on desktop to compare the issuer scan and boxed drafts. Confirm or correct flagged lines individually before completing each page. If lines are missing, use the existing desktop workflow to box and transcribe them. Line-by-line verification remains available. The upload flag is independent of issuer review.

Completed decisions and completeness exports go privately back to eval under the existing restricted workflow.
