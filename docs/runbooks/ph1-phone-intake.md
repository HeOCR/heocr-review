# PH1 phone intake

The upload form is `https://review.heocr.org/ph1`. It accepts original JPEG,
still HEIC and PNG files, one request per photo. Inputs are capped at 20 MiB
per photo and 240 distinct receipts for the event. Participants pick their
assigned code and confirm the wording shown. No Google account is used.
The collector is open only on 26 November 2026, 00:00 to 24:00 Israel time.
Files the sanitizer cannot safely process must stay with the participant
and use the approved offline transfer and sanitization path.

## Stage and activate

Deploy reviewed main using the production runbook, leaving
`PH1_CAPTURE_ENABLED` unset. Signed-out GET `/ph1`, POST
`/api/ph1/upload`, and uncredentialed GET
`/api/ph1/operator/export` must return 404. Do not make production
test uploads. Keep existing flags unchanged.

Before the separate launch approval, set these bindings in the private
Worker secrets file (0600). Do not move credentials into URLs or logs.

- `PH1_CONSENT` is one JSON string with `version` and `text`, using the
  approved intake-specific consent wording. Keep the version fixed for the
  event. The operator manifest records the text digest and version.
- `PH1_EVENT_CODE_SHA256` is the lowercase SHA-256 of the event code as
  entered, excluding any trailing line feed. Generate the code using at
  least 128 random bits and share it only with the organiser and participants.
- `PH1_OPERATOR_SHA256` is the equivalent verifier of a distinct read-only
  bearer with prefix `heocr_ph1_v1_` followed by 43 base64url characters
  (32 random bytes). Supply it only to the intake custodian.
- `PH1_CAPTURE_ENABLED=1` only after explicit approval. The server also
  checks the event date, code and consent version. These checks do not
  affect the other capture flows.

Use the existing private restricted R2 binding. It must have public access
and custom domains disabled. This route cannot use the TRAIN bucket
because matching and split assignment happen after custody. The Worker
hashes the input in memory, strips location-bearing metadata
server-side, and copies coded image data without decoding or re-encoding.
It preserves Make, Model, timestamps, orientation and known camera/lens
EXIF. It removes opaque metadata such as embedded XMP, IPTC, maker notes
and JPEG trailers. The upload audit contains tag names and hashes without
location values. Only sanitized bytes are eligible for storage. Each
conditional R2 object write records one receipt and its metadata. There
are no D1 writes or schema changes. A byte-identical retry by the same
participant returns the previous receipt.

## Custodian export

From the canonical host use an Authorization bearer header on
`GET /api/ph1/operator/export` to retrieve
`heocr.ph1_phone_intake.v1`. This gives the accepted count, consent
receipts, original filenames, both hashes, removal tag names, Make/Model
and a per-photo download path. GET each path with that same credential and
verify the body against `sanitized_sha256` in the manifest. Never forward
the bearer or publish captures. The export remains usable when the
capture flag is unset or the window has closed.

Transfer verified files under `ph1/raw/<participant>/<original_filename>`
in restricted custody. If the manifest contains two different photos with
the same destination name, hold the collision for the custodian to resolve
before writing either path. Wait for the event to close for a final
inventory. Identity screening, QR matching, scanner ingest, slot
admission and freeze occur offline using the intake registration. Keep
the code-to-person key with the organiser and separate from these files.
