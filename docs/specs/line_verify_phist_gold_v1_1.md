# line_verify volunteer resolution v1.1: P-hist gold (addendum)

Status: **draft for heocr-eval's and heocr-lead's check** (2026-11-19). It is the spec only; the code follows in the
same PR once the open questions below are answered. It extends
[line_verify_volunteer_resolution_v1.md](line_verify_volunteer_resolution_v1.md) (v1). Everything v1 says still
holds unless this file changes it.

The rule is eval's: a decision on a P-hist test line counts only when its reviewer has standing on the mid-century
gold (as in v1) **and** at least 90% on at least 15 P-hist gold lines. The P-hist gold lines are eval's
`phist_gold_v1_1.json` (heocr-restricted-eval `preregistration/phist_volunteer_gold_2026-11-19/`, sha256
`99bbf813fe94f3184d13abc98de550301e78ec99f5ac94b18e6c11e9e7408bed`). There are 66 lines from 9 audit2 (P-hist dev)
books, none reserved: 22 `verify` (8 with a planted error) and 44 `type`.

## Where it applies

It applies to a line_verify batch with the batch setting `resolution` set to **`volunteer_v1_1`**, a new value next
to `single` and `volunteer_v1`. Both P-hist test batches move to it. They have 0 decisions on preview, so
`batch-setting` accepts the change. A `volunteer_v1` batch keeps v1's rules exactly.

## Gold lines in a batch

- **Import:** `npm run import-gold -- --batch <id> --gold <dir> [--target ...]` adds the gold lines to an existing
  `volunteer_v1_1` batch as proposals with external id `gold:<gold_id>` and `payload.gold = { gold_id, answer,
  planted_error }`.
  - `<dir>` holds `phist_gold_v1_1.json` and its page images.
  - The import refuses any file whose sha256 is not the registered one, and any image whose sha256 differs from the
    record.
  - It is idempotent. Each P-hist batch gets the same 66 lines.
- **Rank:** gold proposals sit outside the batch's rank order. The normal queue never serves them; only placement
  (below) does.
- **What it looks like:** a gold line is shown exactly like a pass-1 line of the same kind in that batch, with nothing
  that marks it as gold.
  - A `verify` gold line shows `prefill_shown` as its candidate, with the planted error where there is one.
  - A `type` gold line shows the blank box.
  - The same options apply, and no pre-check note is shown.
  - Its context box follows the bundles' rule: the line box widened by 1.5 line heights above and below, clamped to the
    page. Measured on the P-hist v2 bundle, the median is 1.5 above and 1.5 below, at the line's own width.
- **Page metadata:** this is the attribution line, title, licence and size the view shows for every line. The
  importer needs it per gold page (see open question 1).
- **Finality:** a gold decision is final, as every decision on these batches is.

## Placement

Each reviewer has one gold schedule across all `volunteer_v1_1` batches, seeded by
`sha256("phist_gold|" + reviewer_id)`, as the mid-century gold is seeded by its own prefix.

- **When:** when `next` would serve the reviewer their n-th line in a `volunteer_v1_1` batch (n counts their decisions
  in all such batches, gold included), it serves a gold line instead if n falls on the schedule. The schedule is about
  1 in 15, at a seeded offset in each block of 15 (see open question 2 for the first lines).
- **Which line:** the next gold line in the reviewer's seeded order whose `gold_id` they have not decided in any such
  batch and that is not pulled. Gold is served only while the batch still has a normal line for the reviewer; when
  the gold runs out, none is served. A reviewer sees each gold line at most once.
- **Admins included:** the admin (the maintainer) is served gold like anyone else. He goes through the same gate,
  except at the maintainer step (v1).

## Grading

- **Hit:** a gold decision is a hit when its v1 agreement value (`decisionValue`, line_fold_v1) equals the answer's,
  `text` + fold(answer.text). Concretely:
  - **exact** is a hit only on a `verify` line with no planted error;
  - **edited** or **typed** is a hit when its folded text equals the folded answer;
  - **misaligned** with typed text is graded as text;
  - every non-text answer is a miss: unreadable, not one line, no text, continued, and print has niqqud (open
    question 3).
- **Grading time:** at decision time, and stored with the decision.

## Who counts

A decision on a normal line of a `volunteer_v1_1` batch counts when, at the moment of deciding, its reviewer:

1. is `counting` in the mid-century gate batch (v1); and
2. has at least **15** graded, unpulled P-hist gold decisions, with hits / graded of at least **0.90**.

The maintainer step still counts by role (v1). The result and its reason are stored in `verify_votes` and never
recomputed: a reviewer who reaches standing later does not turn earlier decisions into counted ones.

- **New `not_counted_reason` values:** `fewer_than_15_phist_gold` and `below_phist_floor`. When both gates fail, the
  mid-century reason is the one given.
- **Gold decisions** are never routing decisions: they are not in `lines` and never fill a step.

## Pulling a gold line

An admin can pull a gold line when its answer turns out wrong:
`PUT /api/admin/phist-gold/<gold_id> { pulled: true, reason }`. The pull is stored in migration 0010's
`phist_gold_pulls` (`gold_id`, `pulled_at`, `pulled_by`, `reason`).

- A pulled line is no longer served.
- It drops out of every reviewer's graded count from that moment, so standing is recomputed for **future** decisions
  only. Decisions already counted, or not counted, stay as they were stored.
- Un-pulling (`pulled: false`) is the reverse, and is also forward-only.

## Export: line_verify_decisions.v1.5

The export is v1.4 for a `volunteer_v1_1` batch, plus:

- **Header:** `resolution: "volunteer_v1_1"` and `phist_gold: { file, sha256, lines, pulled: [gold_id…] }`.
- **`gold`:** one record per gold decision, with `decision_id`, `reviewer`, `gold_id`, `kind`, `value`, `text`, `hit`,
  `pulled` (at export time) and `decided_at`. Gold decisions are not in `decisions` or `lines`.
- **`not_counted_reason`:** gains the two values above.

The public view (README, "Public copies") drops `gold` with everything else that states a pseudonym's accuracy, and
`check-public` refuses it.

## Privacy text

Privacy policy 2026-11-18-v3's check-lines item says:

> some lines have a known answer. We compare your answers on them and keep an accuracy figure under your pseudonym. It
> is visible to admins only and never published. If it falls below the threshold, your decisions stop counting toward
> agreement between volunteers.

That describes P-hist gold as written. Read this way, no text change and no new approval is needed. **For lead to
confirm.**

## Open questions (eval, then lead)

1. **Page metadata.** `phist_gold_v1_1.json` has no `book_title`, `page_label`, `text_license`, `attribution`,
   `width`, `height`, `script` or `book_group` for its 20 pages. Can v1.1.1 add a `pages` block in the P-hist bundles'
   page format? Without it the gold lines would show a blank attribution, which would mark them as gold.
2. **Early lines.** At 1 in 15, a reviewer reaches 15 graded gold lines after about 225 lines, and decisions are judged
   at decision time. So their first ~225 P-hist decisions never count. That is wasted work, unless they are routed and
   later decided again. The 66 lines last a reviewer about 990 lines.
   - **Suggestion:** 1 in 5 for a reviewer's first 75 lines (15 gold), then 1 in 15. Their 66 lines then last about
     800 lines.
   - **Or:** count decisions retroactively once standing is reached, as the mid-century line_consensus does
     ("past ones included"). That reverses v1's "recorded at decision time".
3. **Print has niqqud.** Is it a miss even when its letters fold to the answer? Eval's rule says non-text answers are
   misses. The P-hist pages are unpointed, so a pointed answer there is a misreading, but please confirm.
4. **One schedule or one per batch.** One schedule across both P-hist batches (proposed), so a reviewer's 15 gold lines
   can come from either.

— contrib[claude/claude-code#shay-macbook-m4]@heocr/opensource
