# Handwriting v3 self-enrolment

At `/app/#contributor`, a signed-in writer enters an invitation code and
chooses an age band of 10 or older. The Worker selects the least-filled
split with room remaining before offering any sets. Within that split it
offers every least-assigned set. The writer selects one set and gets all four
of its sheets. The write checks the offered split and set against current
allocations. A stale offer asks the writer to check again, leaving the
invitation use available. Multiple writers in the same split can copy the
same sheet.
Registration takes at most 50 writers and 200 uploaded sheets, one upload
per writer and assigned sheet. A rejected signup leaves its code use
available.

A writer aged 10–17 shares the pairing code privately with their guardian.
The guardian opens the same page, signs in with a separate account, reads
the pinned wording and submits the code with consent. The writer signs in
again, checks for the guardian response and assents. Adult writers consent
directly. A writer or their paired guardian can withdraw in the app.
The operator can also process a verified deletion request by receipt.

## Private launch plan

Migration `0026_handwriting_self_enrolment.sql` copies the existing
contributor tables and adds the roster, invite revocation and checkpoint
tables. Migration `0027_handwriting_withdrawal.sql` adds publication pins,
withdrawal receipt digests and an opt-out flag. Migration `0028` adds
the roster operator's rate and access audit. Migration `0029` requires a
checkpoint covering the writer before a submission enters the release
candidates view. Use the production runbook,
rehearsal against a restore-readable
export, a current
D1 budget including the table copies and indexes, a clean deployed commit
and a rollback target. Seal all real inputs outside the source tree and
static bundle. Keep the other capture flags disabled.

Store the exact UTF-8 plan at
`contributor-v1/handwriting-signup/<sha256>.json` in private TRAIN R2.
It contains these fields:

- `schema` is `heocr.handwriting_signup.v1`.
- `approval` and `policy` use the contributor v1 format, with the eval
  allocation digest (`evalSplitSha256`), lead authorization and unchanged
  CC0 consent copy. Include the registered calibration amendment digest as
  `approval.allocationAmendmentSha256`.
- `writerLimit` is the total enrolled-writer cap, initially 50. A private
  plan can set a smaller integer.
- `capacity` lists `{split,max}` for each approved split in tie-break
  order. Assignment chooses the allowed split with the fewest allocations
  and room remaining. The maxima must cover the writer limit. Allocations
  count after withdrawal. Only provisioned private split buckets can
  be selected.
- `setsBySplit` maps each configured split to its permitted sets. Every
  set belongs to exactly one split. The plan validator rejects a normalized
  sentence shared across splits in lines 1–29, even when the sheets have
  different hashes.
- `lineRoles` is `{"30":"calibration"}`. All 20 sheets share that exact
  line. Keep it in the copy task. Exclude it from DEV and EVAL-open
  references, denominators and scores. TRAIN may use it.
- `invites` contains the SHA-256 of each individually issued single-use
  invitation. It may be empty with a cohort code.
- Optional `cohort` specifies `{sha256,maxUses,expiresAt}` for a single
  shared invitation. Use cap is initially 50 (1–50) and the expiry is
  an absolute UTC ISO date and time. Hash independently generated
  128-bit lower-case hex codes as UTF-8 text with no trailing newline.
  Give plaintext codes to the organiser through private custody.
- `sheets` maps `A` to `E` to four ordered handwriting tasks
  `HW-V3-<set>01` through `04`. Include the approved 30
  sentences, prompt SHA, rights and PDF SHA for each. Use the contributor
  v1 handwriting task shape. Store each PDF only in the private bucket
  assigned to its set at `contributor-v1/sheets/<sha256>.pdf`. Read the
  plan and each PDF back against its pin.

Pin `CONTRIBUTOR_HANDWRITING_CONFIG_SHA256` with collection off for the eval
operator's readback. Enable `CONTRIBUTOR_APP_ENABLED=1` only after the
separate collection approval. Before that approval, give eval ordered
per-sheet line hashes and hash-only counts for exact matches and policy-v2
word six-gram tags. Report DEV and EVAL-open lines both with and without
the tags, excluding calibration from both views. Keep
`CONTRIBUTOR_CONFIG_SHA256` unset for this handwriting-only launch. The enabled plan is immutable for the pilot.
Registration and guardian pairing have an eight-attempt-per-minute
limit per account per isolate. Existing contributor request limits and
the hard pilot enrolment, submission-size and per-sheet caps still apply.

## Revoke a code

From the canonical host an authenticated admin can POST `{sha256}` to
`/api/contributor/v1/operator/handwriting-invites/revoke`. Supply the
configured invite digest. Keep the raw code out of URLs and logs.
Revocation stops new enrolments through that code and keeps enrolled
writers, consent and assignments intact. Concurrent use-cap, set-balance
and revocation checks run against the same D1 assignment write.

## Daily eval checkpoint

The HeOCR organisation owns the machine principal `eval-operator`, set in
`CONTRIBUTOR_ROSTER_REVIEWER_ID`. The bearer lives in
`~/.config/heocr/heocr-review-eval-operator.token` (0600). Before the
authorised deploy, set only its SHA-256, excluding the file's final LF, as
`CONTRIBUTOR_ROSTER_TOKEN_SHA256` in the private Worker secrets used by
`scripts/deploy.ts`. Read the token inside the HTTP client from its file.
Keep it out of command arguments, output, URLs and the repository.

Set `Authorization: Bearer <token>` and GET
`https://review.heocr.org/api/contributor/v1/operator/handwriting-roster`.
The credential covers only GET and POST on this exact path. It works with a
pinned plan while collection is off. Archive the
`canonical` string as UTF-8 exactly as returned, including its final LF.
The rows contain ordinal, writer code, age band, set and split. No account
IDs or consent records appear in this snapshot. Keep the snapshot in
private custody. Review the allocation and append-only prefix, and
verify the reported SHA-256 against these bytes. Both GET and POST reject a
roster containing a writer whose assigned set falls outside their split.

POST the reviewed `{sha256,throughOrdinal,previousSha256}` back to the
same endpoint as JSON with the bearer. Read the head back. A stale or
changed prefix fails. The API admits up to six GET and three POST per
five-minute UTC window, returning `429` and `Retry-After` at the limit.
Each admitted request writes one audit row and its index in
`contributor_handwriting_roster_access` before it runs, recording only the
machine principal, method and timestamp. Even at the cap this is at most
5,184 audit row and index writes per UTC day, plus any successful
checkpoint inserts. Budget for those writes before an authenticated live
check. Invalid credentials and denied routes add no audit rows.

Evalcheck runs the GET, byte verification and approved POST. Heocr-eval
reviews and pins the roster digests. The checkpoint audits the enrolled roster. Any
enrolled writer with current consent can access their sheets and upload
before the audit. The upload write matches the writer, assigned split, age
band and sheet set to the current private plan's roster entry again.

## Withdrawal and release

Withdrawal closes uploads and removes the writer's submissions from the
`contributor_handwriting_release_candidates` view before R2 cleanup. It
deletes unpublished originals in the assigned bucket, removes D1
submission and enrolment rows, and leaves published copies and release pins
intact. The roster keeps pseudonymous assignment history for the cap and
the audit chain. The receipt is retained only as a digest in that history.
The site's sign-in record keeps a handwriting opt-out flag without a link
to the deleted enrolment so the person cannot be given another split.

The receipt endpoint remains available to the operator when intake is off.
Retry a pending cleanup by POSTing to
`/api/contributor/v1/operator/withdrawals/<receipt>` from the canonical
origin. Repeat after in-flight requests drain. Reconcile any staging or
working copies governed by the withdrawal before acknowledging completion.
Keep receipts, account IDs and working copies out of logs.

Uploads remain in their private split buckets. Before a submission leaves
quarantine, require a roster checkpoint that covers its writer, a passed
operator review for page identity and privacy, and eval approval of the
split's intended use. The release candidates view enforces checkpoint
coverage. The operator and eval record the other two approvals separately.
Check all three again before any downstream use, after reconciling
withdrawal requests. Verify the public release
manifest and byte readback with the lead. To pin an exact published original,
POST `{contentSha256,releaseSha256}` to
`/api/contributor/v1/operator/handwriting-publications` as the operator.
Pin only original bytes whose exact digest is in the release. Published
derivatives do not pin their unpublished originals. The endpoint records a
confirmed release, and has no publication capability.

The pilot admits at most 200 submissions. Budget the withdrawal closeout
for up to four submission and index deletions per writer, one enrolment
and its indexes, one roster digest and its index, and the sign-in opt-out.

## Set E · Hebrew poetry

Set E, "שירה עברית" / "Hebrew poetry", holds kid-friendly public-domain poems by Bialik, Rachel and Tchernichovsky.
Its sheets are `HW-V3-E01` to `HW-V3-E04`. It is a TRAIN set: a plan maps it under `setsBySplit.train`, next to A and
B. Migration `0030_handwriting_set_e.sql` widens the roster's `set_id` check. It rebuilds the roster table with the
same rows and indexes, and recreates the release-candidates view. The source and provenance are in heocr-ops
`codex-pool/open-sets/handwriting-v3/set-e/`. Before the set goes in a pinned plan, it needs eval's TRAIN approval
and heocr-clean's CLEAN receipt.

## Kids' cohort (allocation amendment 3, restricted-eval #960)

Kids' collection is **OFF** until the pinned plan carries a `kids` block. Without it, no minor (10–12 or 13–17) can enrol at all: every minor goes through the kids' block, never the adult route.

- **Switch on:** upload eval's `kids_slots_v1.json` unchanged to `TRAIN_CAPTURE_MEDIA` at
  `contributor-v1/handwriting-kids-slots/<sha256>.json` (sha `3463517a…`). Then pin a new plan that adds
  `"kids": {"slotsSha256": "<that sha>"}` and sheets for all seven sets A–G. Sets F (TEST) and G (DEV) come from
  eval; this repo never holds their text.
- **Signup:** a kid (age band 10–12 or 13–17) takes the next unused slot of their band, in signup order. The slot's
  split is fixed then (TRAIN / DEV / TEST → train / dev / eval_open). The roster row stores `kids_slot` and the second
  set; withdrawal keeps the row, so a slot is never reused. No name or exact age is stored.
- **Packs (8 sheets):** TRAIN = E01–E04 + the kid's pick of A or B; DEV = C01–C04 + G01–G04; TEST = D01–D04 + F01–F04.
- **Order:** `seed = sha256("20261125:hw3-kids-order:" + writer code)`; the 8 pages sorted ascending by
  `sha256(seed + ":" + page)` (hex). The kid's screen serves them in that order and shows "X / 8".
- **Adults are unchanged:** kids' rows never count toward the adult capacity or `writerLimit`. The checkpoint
  snapshot keeps the v1 row shape for adults and adds `slot` and `second` on kids' rows.
- **Before ON:** a dry signup on a local Worker only (`npm run dev` with a local plan), never production. Then
  eval's read-only checks: the deployed slot-list sha, the pack per split, and the checkpoint.

## Family-staff cohort (allocation amendment 6, restricted-eval #2035)

An adult cohort on its **own pinned plan**. It is separate from the v3 plan above, so switching it on never changes
that plan's pin or its enrolled writers. It's OFF unless `CONTRIBUTOR_FAMILY_STAFF_CONFIG_SHA256` is set.

- **Plan:** `heocr.handwriting_family_staff.v1`, stored at `contributor-v1/handwriting-family-staff/<sha256>.json` in
  the **private DEV bucket** (`CONTRIBUTOR_DEV_MEDIA`), because it holds the DEV pack's text. Fields:
  `approval` (including `allocationAmendmentSha256` = amendment 6) and `policy` (the v3 adult consent, unchanged);
  `invite` `{sha256,maxUses,expiresAt}` (one shared code, hashed like the v3 cohort code, `maxUses` ≤ 50);
  `calibration` (the shared line, exactly once in each pack); and `packs` `{train,dev}`. Each pack has 8–10 handwriting
  tasks `HW-FS-T01…` or `HW-FS-D01…`, with 8–12 sentences each, a sheet PDF pin, a prompt pin and rights. No other
  line may repeat within or across the packs.
- **Sheet PDFs** go in the split's own bucket at `contributor-v1/sheets/<sha256>.pdf`: TRAIN in the TRAIN bucket, DEV
  in the DEV bucket.
- **Signup:** adults only. The next slot n is fixed with its split before any sheet is shown: 1 DEV, 2 TRAIN, 3 DEV,
  then TRAIN when sha256(`20261128:hw3-family-staff:<n>`) < 0.7 (first 16 hex digits ÷ 16¹⁶), else DEV. Withdrawal keeps
  the roster row, so a slot is never reused. Each writer gets their split's pack in a seeded order (prefix
  `20261128:hw3-family-staff-order:`).
- **No payment:** no payment code is ever shown, and `ops-health` payment views don't read this roster.
- **Release:** these rows aren't in `contributor_handwriting_release_candidates`, so nothing can be published. Any
  later release needs its own change.
- **Eval roster:** read it with a production D1 query over `contributor_family_staff_roster` (slot, writer code, split).
  The roster checkpoint endpoint covers only the v3 plan.
- **Revoke** the code with the same operator revoke route.
