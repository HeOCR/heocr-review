# Known issues

Hard cases found while reviewing, each with what was done for now and what is still open. No line text and no
private details here: the per-case records (which source, which lines) are kept privately with the maintainer.

## Inline superscript note markers in mid-century print

- **Found:** 2026-11-19, by the maintainer, while verifying lines.
- **What:** some mid-century printed books carry inline superscript note markers (footnote numbers) in the running
  text, often 3 to 8 on one short line. The proposed line text omits them. Fixing every marker by hand is slow and
  tiring, so in practice a reviewer won't work through such lines.
- **Open question:** line references must decide whether to transcribe these markers or leave them out. That decision
  belongs to the line reference spec, with eval; until it is made, a reviewer can't mark such a line `exact` with
  confidence either way.
- **Done for now** (maintainer's decision, 2026-11-19): every line from the one affected book was taken out of line
  review. That's 39 lines in `line_verify_v1`, 32 of them with a decision. The lines were deactivated (`active = 0`),
  never deleted, so the change can be reversed. Their decisions stay in the database, and the export leaves them out,
  as it does every inactive line. The book was not in any other line batch. Its one page in `e2d4_reference_audit_v1`
  (a page-level audit, already fully decided) was left as it was.
- **To undo:** set those lines active again from the private record (`UPDATE proposals SET active = 1 WHERE id IN (…)`).
- **Next:** if the reference spec decides to transcribe the markers, the lines can return with proposals that carry
  them. Then watch for the same markers in other mid-century books before they reach volunteers.

- The review screen's progress bar has no accessible name (axe `aria-progressbar-name`). The browser suite tracks this existing WCAG issue as an explicit baseline; it should be removed when the bar has a reviewed, localised label.
