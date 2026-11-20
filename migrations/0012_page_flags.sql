-- Handwriting transcription (task type line_transcribe, 2026-11-18): a volunteer's report that a page has a text
-- line no box covers ("text outside the boxes"), and the maintainer's answer. A report is not a decision on any line:
-- the volunteer goes on typing the line in front of them. Reported pages wait in the maintainer's queue; a confirmed
-- page goes back to data-collection for re-boxing. Deleting a reviewer's record deletes their reports.
CREATE TABLE page_flags (
  item_id INTEGER NOT NULL REFERENCES items(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('text_outside_boxes')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, reviewer_id, kind)
);

CREATE TABLE page_flag_answers (
  item_id INTEGER NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL CHECK (kind IN ('text_outside_boxes')),
  answer TEXT NOT NULL CHECK (answer IN ('confirmed', 'dismissed')),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  answered_at TEXT NOT NULL,
  PRIMARY KEY (item_id, kind)
);
