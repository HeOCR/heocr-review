# line_verify volunteer resolution v1.1: P-hist gold (addendum)

Status: **agreed** (2026-11-19). heocr-eval answered the open questions, and heocr-lead confirmed the privacy text and
the two design leans. Implemented in this PR: `src/tasks/line_verify/gold.ts` (the rules), `src/worker/phist_gold.ts`
(D1), `scripts/import-gold.ts`, migration `0010_phist_gold.sql`. It extends
[line_verify_volunteer_resolution_v1.md](line_verify_volunteer_resolution_v1.md) (v1). Everything v1 says still
holds unless this file changes it.

The rule is eval's: a decision on a P-hist test line counts only when its reviewer has standing on the mid-century
gold (as in v1) **and** at least 90% on at least 15 P-hist gold lines. The P-hist gold lines are eval's
`phist_gold_v1_1_1.json` (heocr-restricted-eval#93, `preregistration/phist_volunteer_gold_2026-11-19/`, sha256
`08bdb75e62485cd9cd3a9597c56712f25d05cabd7dc0157aa97813f0981c6393`). There are 65 lines on 19 pages from 9 audit2
(P-hist dev) books, none reserved: 22 `verify` (8 with a planted error) and 43 `type`. v1.1.1 adds a `pages` block in
the P-hist bundles' page format (attribution, licence, size), and drops every line from pointed print (see Grading).
v1.1 (`99bbf813…`, no page metadata) is superseded, and the import refuses it.

## Where it applies

It applies to a line_verify batch with the batch setting `resolution` set to **`volunteer_v1_1`**, a new value next
to `single` and `volunteer_v1`. Both P-hist test batches move to it. They have 0 decisions on preview, so
`batch-setting` accepts the change. A `volunteer_v1` batch keeps v1's rules exactly.

## Gold lines in a batch

- **Import:** `npm run import-gold -- --batch <id> --gold <dir> [--target ...]` adds the gold lines to an existing
  `volunteer_v1_1` batch as proposals with external id `gold:<gold_id>` and `payload.gold = { gold_id, answer,
  planted_error }`.
  - `<dir>` holds `phist_gold_v1_1_1.json` and its page images.
  - The import refuses any file whose sha256 is not the registered one, and any image whose sha256 differs from the
    record.
  - It is idempotent. Each P-hist batch gets the same 66 lines.
- **Rank:** gold proposals sit outside the batch's rank order. The normal queue never serves them; only placement
  (below) does.
- **What it looks like:** a gold line is shown exactly like a pass-1 line of the same kind in that batch, with nothing
  that marks it as gold.
  - A `verify` gold line shows `prefill_shown` as its candidate, with the planted error where there is one.
  - A `type` gold line shows the blank box.
  - The same options apply. **No pre-check note** is shown on a gold line: the test lines' notes come from an agent
    pass that gold never had, and a drawn reason would mislead on exactly the lines that measure the reviewer
    (heocr-eval). **Known limitation:** 134 of the test batch's 615 verify lines carry a note, and gold verify lines
    never do; a weak signal, accepted as the lesser harm. A typed gold line's provenance is `none`, the value the
    importer stores for a typed test line whose bundle provenance is null.
  - Its context box follows the bundles' rule: the line box widened by 1.5 line heights above and below, clamped to the
    page. Measured on the P-hist v2 bundle, the median is 1.5 above and 1.5 below, at the line's own width.
- **Page metadata:** each gold line carries its page's entry from the file's `pages` block (source, book, title, page
  label, licence, attribution, size, script, book group), copied into the payload as for a bundle line, so the view
  shows a real attribution. The import refuses a gold line whose page has no entry, and a page licence that is not open.
- **Finality:** a gold decision is final, as every decision on these batches is.

## Placement

Each reviewer has one gold schedule across all `volunteer_v1_1` batches, seeded by
`sha256("phist_gold|" + reviewer_id)`, as the mid-century gold is seeded by its own prefix.

- **When:** when `next` would serve the reviewer their n-th line in a `volunteer_v1_1` batch (n counts their decisions
  in all such batches, gold included), it serves a gold line instead if n falls on the schedule.
  - **Front-loaded:** for a reviewer's first 75 lines, one in each block of 5, at an offset seeded per reviewer and
    per block (`sha256("phist_gold|" + reviewer_id + "|" + block)`), so the position varies from block to block. That
    gives 15 gold lines by line 75, the second gate's minimum.
  - **Then:** one in each block of 15, at a seeded offset in the block.
  - The 65 lines last a reviewer about 790 lines.
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
  - every non-text answer is a miss: unreadable, not one line, no text, continued, and print has niqqud. That is fair
    because v1.1.1 has no gold line from pointed print (pages with a reference niqqud ratio of 0.02 or more, and
    answers carrying a mark).
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

That describes P-hist gold as written. heocr-lead confirmed (2026-11-19) that the item is not batch-specific and
covers P-hist gold, so no text change and no new approval is needed.

## Decided (2026-11-19)

1. **Page metadata:** in the file (v1.1.1, a `pages` block). Lead: gold lines must carry real page attribution.
2. **Early lines:** front-loaded, 1 in 5 for the first 75 lines, then 1 in 15. Decisions stay judged at decision time,
   with no retroactive counting. Lead agreed.
3. **Print has niqqud:** a miss; v1.1.1 has no gold line from pointed print.
4. **Schedule:** one seeded schedule per reviewer across both P-hist batches, with no gold_id repeated.

— contrib[claude/claude-code#shay-macbook-m4]@heocr/opensource
