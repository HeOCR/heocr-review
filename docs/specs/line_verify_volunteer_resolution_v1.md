# line_verify volunteer resolution, v1 (P-hist test batches)

Status: **draft for heocr-eval's and heocr-lead's check** (2026-11-18). The rules are heocr-eval's final scheme of
2026-11-18, after lead's leans; this file says how the app implements them. The code follows in the same PR.

## Where it applies

A line_verify batch whose batch setting `resolution` is `volunteer_v1` (migrations/0009, set with
`npm run batch-setting -- --batch <id> --resolution volunteer_v1 --by <who>`; default `single`, today's behaviour).
For the P-hist test batches it is set on both re-cut batches, with `blind_second_pass` empty and `two_typings_groups`
and `pass2_reviewer` unused. Every other batch is unchanged.

## Who counts

A decision **counts** when its reviewer, at the moment of deciding, is `counting` in the mid-century volunteer batch
(`newprinted_midcentury_volunteers_v0`): 95% or better on 20 or more gold lines, not excluded by the admin
(the line_consensus standing, the same as H). The maintainer (Shay's admin account) goes through the same gate.
Whether a decision counted, and the standing it was judged on, are stored with it when it is made and never
recomputed: a reviewer who gains standing later does not turn earlier decisions into counted ones.

A decision that does not count is stored and exported (`counted: false`), and routing ignores it. Anyone signed in
may decide (a counting rule, not an access gate, as in H), but the reviewer cannot decide the same line again.

**For eval to confirm:** a decision made at the **maintainer** step counts by role, whatever the maintainer's
standing; otherwise the maintainer step could never resolve a line while Shay has no mid-century gold.

## What a reviewer sees

Every decision is independent. Nobody sees another reviewer's answer, at any step.

- A **verify** line shows the candidate, as today (exact, edit, print has niqqud, unreadable, misaligned with the line
  typed). The second, third, maintainer and fourth decisions see the same screen: the candidate again, no options
  taken from the others (showing them would anchor the decider).
- A **type** line shows the blank box, as today (typed, print has niqqud with the letters, unreadable, not one line,
  no text, continued), at every step.
- Decisions on these lines are **final** (as on volunteer lines): once a reviewer decides, they cannot change it.

## When two decisions agree

Each decision has a value; two decisions agree when their values are equal.

| Decision | Value |
|---|---|
| exact (verify) | `text` + fold(candidate) |
| edited (verify) | `text` + fold(edited text) |
| typed (type) | `text` + fold(typed text) |
| misaligned with its typed text (verify, v1.2) | `text` + fold(typed text) |
| pointed_print | `pointed` + fold(letters; the candidate's when no letters were typed) |
| unreadable, not_one_line, no_text, continued | the action itself |

`fold` is **line_fold_v1** exactly (tasks/eval-domains/profiles/line_fold_v1.json, sha256 2e262710…1d317): Unicode
NFC; then ־→- ׳→' ״→" “→" ”→" „→" —→–; then every run of whitespace becomes one space, and both ends are stripped.
Niqqud and – vs - are not folded.

## Routing

Only counted decisions take part. A line is **resolved** as soon as any value has two counted decisions.

1. `pass1`, then `pass2`: any two reviewers. Equal values: **agreed**.
2. They differ: `third`, a third reviewer. A value with two decisions: **majority**.
3. Three differ: if the maintainer has **no decision at all** on the line (counted or not), `maintainer`: the line goes
   to the maintainer queue, served to the admin only (**to_maintainer** until he decides). Otherwise `fourth`: any
   volunteer who has not decided it, not the admin.
4. After the fourth counted decision (maintainer or volunteer) with still no pair: **unresolved**. The line is not
   served again, and the export reports it unresolved for eval's page-swap rule (it counts as unreadable there).

No reviewer is ever served a line they have decided, so Shay is never offered any step on a line he typed or
decided; the maintainer step is skipped whenever he has decided the line.

Uncounted decisions do not move the line on: a line with one counted and two uncounted decisions still needs its
`pass2`.

## Queue and progress

A volunteer_v1 line is open to a reviewer when it is not resolved or unresolved, the reviewer has not decided it,
and: at `to_maintainer`, the reviewer is the admin; at `fourth`, the reviewer is not the admin. Lines are served in
the bundle's rank order, as today. The routing state is kept per line (migrations/0009, `verify_state`) and
recomputed in the Worker whenever a decision on the line is recorded; standing is read from the mid-century batch at
that moment. Progress counts a line as covered once it is resolved or unresolved.

## Export (line_verify_decisions.v1.4)

v1.3 plus, for a volunteer_v1 batch:

- every current decision is its own record (as today), with `reviewer` the pseudonymous rv_… id, and new fields
  `counted` (boolean), `not_counted_reason` (`fewer_than_20_gold`, `below_floor` or `excluded_by_admin`; only when
  not counted) and `step` (`pass1`, `pass2`, `third`, `maintainer`, `fourth`, or `uncounted` when it did not count);
- a `lines` list: per line, `item_id`, `kind`, `resolution` (`agreed`, `majority`, `to_maintainer`, `unresolved`,
  `pending`), `reference` (`{ class: "text" | "pointed" | action, text }` when resolved, else null) and the
  `decision_id`s that formed the pair;
- the header gains `resolution: "volunteer_v1"`, the gate batch id and `line_fold_v1`'s sha256.

The app's results are for routing; eval's ingest may recompute them from the records.

## Not in v1

No planted P-hist gold (the mid-century gold is the proxy, per eval). No reviewer sees counts of how others answered.
No change to production until Shay's volunteer-launch review and go.
