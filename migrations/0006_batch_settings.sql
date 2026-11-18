-- Per-batch settings an admin changes without a re-import (2026-11-18). An import never writes this table, so a
-- re-import keeps them. No row: the defaults.
--   pass2_reviewer  who gets a line_verify blind second pass: 'same' (the reviewer who answered pass 1, 24 hours
--                   later: intra-rater) or 'other' (only a reviewer who never decided the line's pass 1, 24 hours after
--                   another reviewer's answer: inter-rater). Default 'same'. page_review's blind pass is always 'same'.
CREATE TABLE batch_settings (
  batch_id TEXT PRIMARY KEY REFERENCES batches(id),
  pass2_reviewer TEXT NOT NULL DEFAULT 'same' CHECK (pass2_reviewer IN ('same', 'other')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
