# Restricted reference consensus queues

A ratified issuer-draft batch can use the exact disagreement and audit order
from a private consensus projection. Accepted lines keep their imported draft
and are counted separately from human decisions. Human answers, skipped
items, source images, and the independent page completeness workflow stay in
the original batch. The typing entry shows a blank editor and source images.
It never sends OCR results or the draft for that line.

Apply migration `0024_reference_consensus.sql` before deploying the Worker.
Test with invented local fixtures. For production follow the normal private
export, clean-main deploy, recount and authorization runbook.

Use the three privately held inputs from the evaluator handoff and the
original issuer import digest. Use the existing allowlisted reviewer ID:

```sh
npx tsx scripts/import-reference-consensus.ts \
  --projection "$projection" --freeze "$freeze" \
  --ratification "$ratification" --ratification-sha256 "$approval_sha" \
  --items-sha256 "$original_items_sha" --reviewer "$reviewer"
```

The default is local and read-only. Production readback also requires
`--target production --yes-production`. Add `--apply` only for an authorized
activation, with the fresh private D1 export path and SHA-256 supplied as
`--backup` and `--backup-sha256` on production. The importer checks the
D1 budget, stages a replayable immutable set of rows, reads it back, then
activates only if the complete current roster still matches. It reports
current human decisions, skips, ordinary and typing queues and page tasks.
Re-run without `--apply` for readback. The signed projection remains the
independent record of automatic agreements and audit membership.

For an authorized routing rollback, change only `active` to zero for the
exact batch and projection SHA-256 in `reference_consensus_runs`. Preserve
the stage and human answers. A rollback puts the original review routes
back. Review outputs stay private until audit, source and exposure checks
are closed.
