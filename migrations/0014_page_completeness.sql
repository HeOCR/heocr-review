-- Page completeness in triage (heocr-eval's reference_triage_v1 amendment 1, heocr-restricted-eval#154): a page's
-- reference is composed of its line answers, so a printed line the segmenter never boxed would be missed. Once a
-- reviewer has answered a page's triage lines, triage shows the page with all its boxes and asks whether every printed
-- line is boxed: 'complete', or 'missing_lines', which sends the page to their desktop queue. There they box and type
-- each missing line (page_added_lines) and finish with 'lines_added'. A newer answer supersedes the last (kept).
CREATE TABLE page_checks (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  answer TEXT NOT NULL CHECK (answer IN ('complete', 'missing_lines', 'lines_added')),
  created_at TEXT NOT NULL,
  decided_on TEXT NOT NULL,
  superseded_at TEXT
);
CREATE UNIQUE INDEX page_checks_one_current ON page_checks (item_id, reviewer_id) WHERE superseded_at IS NULL;
CREATE INDEX page_checks_batch ON page_checks (batch_id, reviewer_id);

-- A line the reviewer added on the desktop: its box (fractions of the page) and its text, typed from a blank box.
CREATE TABLE page_added_lines (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  box_json TEXT NOT NULL,
  text TEXT,
  value TEXT NOT NULL CHECK (value IN ('typed', 'unreadable')),
  created_at TEXT NOT NULL,
  decided_on TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX page_added_lines_page ON page_added_lines (item_id, reviewer_id);
