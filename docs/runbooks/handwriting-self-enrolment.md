# Handwriting v3 self-enrolment

At `/app/#contributor`, one private invitation lets a signed-in writer choose
their age band and one prompt set. Each set is issued at most once. Four
sets of four sheets therefore support up to four writers. A failed set
allocation leaves the invitation unused. Allocate new sheets and obtain a
new eval plan before expanding beyond this pilot.

A writer aged 10–17 shares the pairing code privately with their guardian.
The guardian opens the same page, signs in with a separate account, reads
the pinned wording and submits the code with consent. The writer signs in
again, checks for the guardian response and assents. Adult writers consent
directly. A writer can withdraw at any time. The existing operator process
uses the withdrawal receipt to remove quarantined submissions.

## Private launch plan

Migration `0026_handwriting_self_enrolment.sql` copies the existing
contributor tables and adds the roster and checkpoint tables. Use the
production runbook, rehearsal against a restore-readable export, a current
D1 budget including the table copies and indexes, a clean deployed commit
and a rollback target. Seal all real inputs outside the source tree and
static bundle. Keep the other capture flags disabled.

Store the exact UTF-8 plan at
`contributor-v1/handwriting-signup/<sha256>.json` in private TRAIN R2.
It contains these fields:

- `schema` is `heocr.handwriting_signup.v1`.
- `approval` and `policy` use the contributor v1 format, with the eval
  allocation digest, lead authorization and unchanged CC0 consent copy.
- `capacity` lists `{split,max}` for each approved split in tie-break
  order. Assignment chooses the allowed split with the fewest allocations
  and room remaining. `max` is an integer. Allocations persist after
  withdrawal. Only provisioned private split buckets can be selected.
- `invites` contains the SHA-256 of each independently generated
  128-bit lower-case hex invitation, hashed as UTF-8 text without a
  trailing newline. Its length equals the sum of the caps and cannot
  exceed four. Hand each plaintext code to the organiser privately.
- `sheets` maps `A`, `B`, `C`, `D` to 3–4 ordered handwriting tasks
  `HW-V3-<set>01` through `03` or `04`. Include the approved 30
  sentences, prompt SHA, rights and PDF SHA for each. Use the contributor
  v1 handwriting task shape. Store the PDF in every approved split bucket
  at `contributor-v1/sheets/<sha256>.pdf`. Read the plan and each PDF
  back against its pin.

After the required approvals, configure `CONTRIBUTOR_APP_ENABLED=1`,
`CONTRIBUTOR_HANDWRITING_CONFIG_SHA256` and
`CONTRIBUTOR_ROSTER_REVIEWER_ID` (the eval operator's existing account
pseudonym). Keep `CONTRIBUTOR_CONFIG_SHA256` unset for this
handwriting-only launch. The enabled plan is immutable for the pilot.
Registration and guardian pairing have an eight-attempt-per-minute
limit per account per isolate. Existing contributor request limits and
the hard pilot enrolment, submission-size and per-sheet caps still apply.

## Daily eval checkpoint

From the canonical host using the configured eval operator session, make a
GET to `/api/contributor/v1/operator/handwriting-roster`. Archive the
`canonical` string as UTF-8 exactly as returned, including its final LF.
The rows contain ordinal, writer code, age band, set and split. No account
IDs or consent records appear in this snapshot. Keep the snapshot in
private custody. Review the allocation and append-only prefix, and
verify the reported SHA-256 against these bytes.

POST the reviewed `{sha256,throughOrdinal,previousSha256}` back to the
same endpoint, using the same origin. Read the head back. A stale or
changed prefix fails. The checkpoint audits the enrolled roster. Any
enrolled writer with current consent can access their sheets and upload
before the audit. The upload write matches the writer, assigned split, age
band and sheet set to the current private plan's roster entry again.
Withdrawal closes uploads immediately. Keeping a pseudonymous roster row
preserves the split history and prevents reissuing its sheets.
