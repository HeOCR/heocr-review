# Handwriting page paste

The assigned admin can open an existing triage batch's page-paste queue on a desktop. The full page and zoom sit beside a transcription field. The browser counts lines live. Save requires one entered row per active pass-1 line, in manuscript order, and opens the next registered page.

## Registration

Activate only the page IDs forwarded by eval for the handwriting source. The registration carries IDs and order without scans, transcription text, or candidates:

```json
{
  "schema": "page_paste_registration.v1",
  "batch_id": "h_eval_v1_lines",
  "page_ids": ["<registered page ID>"]
}
```

The operator supplies the pinned SHA-256 and the assigned admin's reviewer pseudonym. In production the command only accepts `h_eval_v1_lines`, and verifies that the assigned reviewer is in the admin configuration. Each page must resolve to an existing image and a nonempty, contiguous, zero-based pass-1 line sequence. The registration pins each proposal's ID, position and current content hash. Its scope is the exact input list.

```sh
npm run register-page-paste -- --page-list <eval-forwarded-json> --sha256 <eval-pin> \
  --reviewer <assigned-admin-id> --target local --dry-run
```

Deploy migration 0016 only on the lead's go. A production dry run requires `--target production --yes-production --dry-run`. Check the page, line, and plant counts with eval before removing `--dry-run`. Applying a registration moves those pages' existing line proposals out of regular triage and fix routing. The proposals stay active for reference exports. Affected plant rows are stamped with the void timestamp and reason `page_paste`. The registration never writes reviewer decisions.

## Save and export

The clipboard's CRLF/CR newlines are normalized. One terminal newline is a delimiter. Interior blank rows are retained and rejected as invalid line text. The existing typed-line text rules apply, including NFC, no niqqud, and one nonempty line per row.

A save requires the assigned admin's authenticated session and current contribution terms. It checks the whole pinned mapping again. All line decisions and the page completion marker are written in one D1 batch. Earlier decisions by the same reviewer are superseded into history on save. A repeated identical submission is safe if the first response was lost. A changed or already-saved page refuses further changes. A paste does not itself certify page box completeness.

The admin's `reference_triage.json` includes the correction source `page_paste` for pasted rows, and a `voided_plants` audit with item IDs, both candidate hashes, the timestamp, and reason. Previous triage answers stay in history. Pasted text is also available as ordinary line-verification decisions.

Open `/app/#b/h_eval_v1_lines/q/paste` after the approved registration is applied. The link and queue are visible only to its assigned admin.
