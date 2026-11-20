-- Existing transcriptions start at revision 1 and stay in place.
ALTER TABLE page_paste_train_decisions
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE TABLE page_paste_train_history (
  page_id INTEGER NOT NULL REFERENCES page_paste_train_pages(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  page_text TEXT NOT NULL,
  entered_count INTEGER NOT NULL CHECK (entered_count >= 0),
  alignment_mismatch INTEGER NOT NULL CHECK (alignment_mismatch IN (0, 1)),
  terms_version TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (page_id, revision)
);

CREATE INDEX page_paste_train_history_reviewer ON page_paste_train_history (reviewer_id);

-- The prior version and its replacement are written in the same statement.
CREATE TRIGGER page_paste_train_archive_revision
BEFORE UPDATE OF revision ON page_paste_train_decisions
WHEN NEW.revision > OLD.revision
BEGIN
  INSERT INTO page_paste_train_history
    (page_id, revision, reviewer_id, page_text, entered_count, alignment_mismatch, terms_version, saved_at)
  VALUES
    (OLD.page_id, OLD.revision, OLD.reviewer_id, OLD.page_text, OLD.entered_count, OLD.alignment_mismatch, OLD.terms_version, OLD.saved_at);
END;
