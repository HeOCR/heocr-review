# 2026-11-18: terms cover handwritten pages and typed text

**Status: approved** by the maintainer on 2026-11-18. Merging deploys nothing; production still waits for the
volunteer-launch review with him.

- **Proposed change:** the smallest edit to the contribution terms that covers the handwriting (H) transcription
  task (task type `line_transcribe`, HeOCR/heocr-review#20). There, volunteers type new text from scratch from
  handwritten pages. The current scope sentence describes only "checking proposed text corrections against scans of
  printed pages".
  1. **Scope sentence** (the consent text, terms item 1, and the home page): printed and handwritten pages; checking
     proposed corrections, or typing the text from the scan.
  2. **The CC0 sentence:** "your decisions and any text you edit **or type**" (Hebrew: "שאתם עורכים **או מקלידים**").
  3. **New version `2026-11-18-v1`.** Every reviewer is asked to accept it before their next decision. CC0 1.0 is
     unchanged (`CONTRIBUTION_LICENCES` maps the new version to CC0-1.0).
- **Not changed:** the licence, credit, fair-use, removal, warranty and privacy items. `PRIVACY_VERSION` stays
  `2026-11-18-v3`, because nothing new is collected. The language choice for other-script pages stays in the browser
  tab and is never stored.
- **Effect on the H task:** #20 serves handwriting lines to volunteers only once they have accepted
  `TRANSCRIBE_TERMS_VERSION` = `2026-11-18-v1` or later. Until this change ships, only the maintainer is served,
  preview included.
- **Covers:** `src/shared/terms.ts` (`TERMS_HE`, `TERMS_EN`, `TERMS_VERSION`), `public/terms.html` (items 1 and 2,
  the version), `public/index.html` (the about sentence, the terms version) and `src/tasks/export.ts`
  (`CONTRIBUTION_LICENCES`).
- **Approved by:** the maintainer, on 2026-11-18, relayed word for word by heocr-lead. Lead explained the change to
  him in plain terms: volunteers will also type the text of handwritten pages, that typed text is CC0 like
  everything else, nothing new is collected, and everyone accepts the terms again before their next decision. His
  answer: "Approve".

— contrib[claude/claude-code#shay-macbook-m4]@heocr/opensource
