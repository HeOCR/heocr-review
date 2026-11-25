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

## Per writer (gift-card payments)

`npm run ops-health -- --by-writer --target production --yes-production [--out handwriting-by-writer.tsv]`

For the maintainer's payments. It prints, for each handwriting v3 writer:
- the pseudonymous writer code (the one the writer sees on their own screen);
- adult or kid;
- sheets uploaded out of the pack (4 for an adult, 8 for a kid);
- a withdrawn mark, if they withdrew.

It shows no account id, e-mail or name. `--out` takes a bare file name and writes it with mode 0600 under `~/.config/heocr/`, never into the repo. It's read-only: one SELECT, and no deploy needed. "Readable" for pay is the maintainer's call and isn't recorded here.
