-- A Hebrew source is pointed or unpointed as a whole (the maintainer, 2026-11-19). When the admin, or a reviewer whose
-- decisions count, marks a line "print has niqqud" in a line_verify batch set to pointed_books = 'drop' (the default),
-- every other undecided line of the same book leaves the batch (active = 0; never deleted). 'keep' turns it off: the
-- pointed batch, whose lines are all pointed, and the maintainer's line-level gold batch.
ALTER TABLE batch_settings ADD COLUMN pointed_books TEXT NOT NULL DEFAULT 'drop' CHECK (pointed_books IN ('drop', 'keep'));

-- The batches known today to need 'keep' (a no-op where they do not exist).
INSERT INTO batch_settings (batch_id, updated_at, updated_by, pointed_books)
  SELECT id, '2026-11-19T00:00:00.000Z', 'migration 0011', 'keep' FROM batches
  WHERE id IN ('line_verify_v1_pointed', 'newprinted_midcentury_goldlines_v0')
  ON CONFLICT (batch_id) DO UPDATE SET pointed_books = 'keep';

-- Every line the rule took out, with the mark that caused it, so a drop can be traced and reversed (set active = 1).
CREATE TABLE pointed_book_drops (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  book_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  dropped_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, proposal_id)
);
