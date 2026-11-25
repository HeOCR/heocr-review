# Daily ops health

`npm run ops-health -- --target production --yes-production` prints one line for heocr-lead (about 08:00 Israel
time; `--json` for the full record). It is read-only and counts only:

- **contributor app:** signed-out `GET /api/contributor/v1/enrolments` (401 = on, 404 = off).
- **handwriting v3:** row counts of the contributor and handwriting tables (enrolments, submissions, roster,
  revoked invites, pins, publications, roster-access audit).
- **PH1:** signed-out `GET /ph1` (200 = on). When on, the operator export's photo count and recompressed count
  only. The bearer is read from `~/.config/heocr/heocr-review-ph1-operator.token` and is never printed; no
  participant code, filename or hash is kept.
- **triage:** per triage batch, pass-1 lines, lines answered, lines waiting for the desktop (a "different", or any
  triage answer on a plant) and plants.
- **decisions:** current decisions in all batches.
- **D1:** rows written today across the account (the daily budget is 1,000,000).

It never writes to D1, never fetches a photo and needs no deploy. `--target local` reads a local Worker on 8787.

## Payment codes (gift-card payments, amendment 3b)

`npm run ops-health -- --by-writer --target production --yes-production [--out handwriting-payments.tsv]`

For the maintainer's payments. Each handwriting v3 writer has a **payment code**: six symbols from
`23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0, O, 1, I or L). The code is HMAC-SHA256 of
`"heocr-payment-code/v1/" + writer code`, keyed by the Worker secret `CONTRIBUTOR_PAYMENT_CODE_SECRET`. Nothing stores
it. The writer sees it on their own handwriting card, labelled "קוד לתשלום" / "Payment code", next to "X / 8".

The operator table shows **only** these columns, sorted by payment code:
- the payment code;
- adult or kid;
- sheets uploaded of the pack (4 or 8);
- a withdrawn mark.

It never shows the writer code, slot, split, set, account, e-mail or name. The writer ids are used in memory to derive
the codes and are then dropped.

A collision within the plan's roster fails loudly here, and the app then shows no code to anyone. The key lives only
in the Worker secrets file, mode 0600, and is never logged or exported. `--out` writes a 0600 file under
`~/.config/heocr/`. It's read-only, with no deploy needed to run it. "Readable" for pay stays the maintainer's call.
