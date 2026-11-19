# Runbook: a reviewer asks to be deleted (DRAFT)

> **Status: draft, 2026-11-16.** The policy is privacy policy `2026-11-16-v2`, "Deletion" item, option C
> ([decision record](../decisions/2026-11-16-reviewer-deletion.md)). There is no deletion code path in the app and no
> script for this. Every query below is **read-only**. The writes in step 6 are described, not scripted. For each
> request, the write SQL is prepared by hand, reviewed by heocr-lead and run on production only with the maintainer's
> approval.

## Rules for the whole procedure

- **No personal data in any log, ticket, PR, commit or chat message.** That covers the requester's email address and
  their pseudonym (`rv_…`), credit name, decision text and any link between them. Keep the pseudonym only in a shell
  variable for the session (`RV=rv_…`), and print counts, never rows.
- **Never record the link between the pseudonym and its placeholder** (`deleted-N`), and never send the placeholder
  id to the requester. A recorded link would undo the unlinking.
- Load credentials with `set -a && . ~/.config/heocr/cloudflare.env && set +a`. Never print the token.
- Run every query from `~/clones/heocr-review` on `main`:
  `npx wrangler d1 execute DB --remote --env= --json --command "<query>"`. Each query below takes the pseudonym as
  `'$RV'`, and it must match `^rv_[0-9a-f]+$` before you use it. Check that with
  `[[ $RV =~ ^rv_[0-9a-f]+$ ]] || echo bad`.

## 1. Verify that the request comes from the reviewer

The app does not store email addresses, and pseudonyms appear in public releases. An email that names a pseudonym
therefore proves nothing. Ask the requester to prove they control the Google account behind it:

1. Reply from heocrproject@gmail.com with a one-time code, for example `delete-K7QM2X` (letters, no `@`, so the
   credit-name check accepts it). Ask them to sign in and set it as their credit name in Settings.
2. Check it without reading the name:

   ```sql
   SELECT display_name = 'delete-K7QM2X' AS verified FROM reviewers WHERE id = '$RV';
   ```

   Go on only when `verified` is `1`. A reviewer who cannot sign in any more cannot be verified this way: take it to
   the maintainer.

## 2. Ask for the choice

Ask once about the decisions that are not yet published: **delete** them, or **keep them with no link** to the
reviewer. Use the policy's own words, in the requester's language. Say that decisions used in a registered evaluation
set are kept unlinked in any case, and that published releases do not change.

- If there is no answer within **14 days** of asking, the default is **unlink**. The 14 days were set by the
  maintainer on 2026-11-16 ([decision record](../decisions/2026-11-16-reviewer-deletion.md)), and they are the same
  for everyone. Tell the requester the date by which they need to answer.
- Tell them that signing in again later starts a fresh, empty record under the same pseudonym, and that nothing
  deleted or unlinked comes back.

## 3. Take inventory (counts only)

```sql
SELECT
  (SELECT COUNT(*) FROM decisions WHERE reviewer_id = '$RV')                             AS decisions_all,
  (SELECT COUNT(*) FROM decisions WHERE reviewer_id = '$RV' AND superseded_at IS NULL)   AS decisions_current,
  (SELECT COUNT(*) FROM drafts WHERE reviewer_id = '$RV')                                AS drafts,
  (SELECT COUNT(*) FROM skips WHERE reviewer_id = '$RV')                                 AS skips,
  (SELECT COUNT(*) FROM assignments WHERE reviewer_id = '$RV')                           AS assignments,
  (SELECT COUNT(*) FROM consent_events WHERE reviewer_id = '$RV')                        AS consent_events,
  (SELECT COUNT(*) FROM rate_limits WHERE key LIKE '%:' || '$RV')                        AS rate_limit_rows;
```

Decisions per batch, and their ids. The ids are needed for step 4. Write them to a file in the scratchpad, not to the
terminal:

```sql
SELECT p.batch_id, COUNT(*) AS n FROM decisions d JOIN proposals p ON p.id = d.proposal_id
WHERE d.reviewer_id = '$RV' GROUP BY p.batch_id;

SELECT d.id AS decision_id, p.batch_id, p.external_id, d.superseded_at IS NULL AS current
FROM decisions d JOIN proposals p ON p.id = d.proposal_id WHERE d.reviewer_id = '$RV';
```

## 4. Sort each decision into one class

Work from the id file. The first class that matches wins.

| Class | Test | What happens |
| --- | --- | --- |
| **P**, published | its `decision_id` appears in any public HeOCR release (the `*_decisions.json` / `*_ledger.json` files exported from heocr-review, in heocr-datasets and its Hugging Face or Zenodo copies) | stays in the releases under the pseudonym. In the database it moves to its **own** placeholder (see step 5) |
| **E**, registered evaluation | its proposal's `external_id` is listed, as a key or an alternate, in a registered evaluation set of the same batch (today `heocr-restricted-eval/preregistration/*/interim_v1.json`, `pages[].key` and `pages[].alternates`), **or** heocr-eval says a registered set used it | **unlink only, never delete**, whatever the reviewer chose |
| **U**, other unpublished | anything else | the reviewer's choice: **delete** or **unlink** (unlink by default) |

- heocr-restricted-eval is restricted. Ask heocr-eval to run the E check against the id file and return the class per
  id. Read the restricted files yourself only if eval asks you to. Nothing from heocr-restricted-eval is imported into
  heocr-review.
- Count each class. As of 2026-11-16 no heocr-review decision id appears in heocr-datasets or heocr-restricted-eval,
  so class P is empty today.

## 5. Pick the placeholders

- **One new placeholder per request**, `deleted-N`, with N one more than the highest in use. Never share one between
  two people:
  - the unique index `decisions_one_current (proposal_id, reviewer_id)` would collide;
  - the export would count two people as one reviewer toward `min_reviewers`.

  ```sql
  SELECT COALESCE(MAX(CAST(SUBSTR(id, 9) AS INTEGER)), 0) + 1 AS next_n
  FROM reviewers WHERE id LIKE 'deleted-%' AND id NOT LIKE '%-pub';
  ```

- **Class P gets a second placeholder, `deleted-N-pub`, and never `deleted-N`.** Decision ids are exported, so a
  published id seen later under `deleted-N` would tie `deleted-N` back to the pseudonym, along with every unlinked
  decision under it. `deleted-N-pub` holds only decisions that are already public under the pseudonym, so it reveals
  nothing new.
- The placeholder row:
  - `blocked = 1`;
  - `display_name` and `display_name_consented_at` NULL;
  - `created_at` and `last_seen_at` set to the time of the deletion;
  - `terms_version` taken from the original row, with `terms_accepted_at` NULL.

  No `rv_` id can sign in as `deleted-…`.

## 6. The writes (prepared by hand, reviewed by heocr-lead, run on the maintainer's approval)

In one `--file` run, in this order:

1. insert the placeholder row(s);
2. move every class E decision, and every class U decision if the choice is unlink, to `deleted-N`. Move class P to
   `deleted-N-pub`. Superseded decisions move with their class. Only `reviewer_id` changes: the decision id, value,
   text, dates and `terms_version` (the CC0 dedication) stay as they are;
3. if the choice is delete: delete the class U decisions (superseded ones too); their `verify_votes` and `phist_gold_grades` rows go with them (`ON DELETE CASCADE`);
4. delete the reviewer's `drafts`, `skips`, `assignments`, `consent_events` and their `rate_limits` rows (key suffix
   `:<pseudonym>`). Their `agreement_exclusions` rows go with the record (`ON DELETE CASCADE`);
5. delete the `reviewers` row. D1 enforces the foreign keys, so this fails if anything still points at it. A failure
   means stop. Don't fix forward: report to heocr-lead.

**Volunteer line batches** (task type `line_consensus`, `migrations/0005_line_consensus.sql`):
- A volunteer's gold-line decisions decide whether their other decisions count. When unlinking, move the gold
  decisions to `deleted-N` with the rest, so the placeholder keeps the volunteer's standing. When deleting, delete them
  with the rest.
- Then recompute the line states of the lines they decided. Toggling the admin exclusion switch on `deleted-N` and back
  recomputes them; with the delete choice, run that on any counting reviewer who decided the same lines. Lines that
  lose a counted decision go back to the queue.
- `maintainer_decisions` holds only the maintainer's decisions, never a volunteer's.

**P-hist gold** (line_verify `volunteer_v1_1`, `migrations/0010_phist_gold.sql`): `phist_gold_grades` also holds the
`reviewer_id`. When unlinking, move its rows to the same placeholder as their decisions in step 2, or step 5 fails on
the foreign key. When deleting, they go with their decisions. Grades and `verify_votes` are never recomputed: a
deletion changes no stored verdict.

Before the production run, rehearse the same file on a local Worker loaded with a private copy of production's D1
(`docs/runbooks/testing-and-imports.md`), never on a remote test database.

## 7. Verify (read-only, counts only)

```sql
SELECT
  (SELECT COUNT(*) FROM reviewers WHERE id = '$RV')                       AS record,
  (SELECT COUNT(*) FROM decisions WHERE reviewer_id = '$RV')              AS decisions,
  (SELECT COUNT(*) FROM drafts WHERE reviewer_id = '$RV')
   + (SELECT COUNT(*) FROM skips WHERE reviewer_id = '$RV')
   + (SELECT COUNT(*) FROM assignments WHERE reviewer_id = '$RV')
   + (SELECT COUNT(*) FROM consent_events WHERE reviewer_id = '$RV')
   + (SELECT COUNT(*) FROM rate_limits WHERE key LIKE '%:' || '$RV')     AS other_rows;
```

All three must be `0`. Then check the placeholders' counts against step 4:

```sql
SELECT reviewer_id, COUNT(*) AS n FROM decisions
WHERE reviewer_id IN ('deleted-N', 'deleted-N-pub') GROUP BY reviewer_id;
```

## 8. Close

- Reply to the requester that it is done, saying what happened to their unpublished decisions (deleted or kept
  unlinked) and how many were kept for registered evaluation sets. Don't name the placeholder.
- Log the request in the private maintainer log with only the date received, the date done, the choice (or "default"),
  and the counts per class. Leave out the email, the pseudonym, the verification code and the placeholder number: the
  email thread carries the pseudonym and the dates, so a placeholder number in the log would rebuild the link.
- Unset `RV` and delete the id file from the scratchpad.

— contrib[claude/claude-code#shay-macbook-m4]@heocr/opensource
