-- Restricted reference material is staged explicitly. Existing batches are
-- untouched until an operator installs the registered roster and private media.
ALTER TABLE batches ADD COLUMN restricted_reference INTEGER NOT NULL DEFAULT 0
  CHECK (restricted_reference IN (0, 1));

CREATE TABLE restricted_reference_pages (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  first_allowed INTEGER NOT NULL DEFAULT 1 CHECK (first_allowed IN (0, 1)),
  blind_allowed INTEGER NOT NULL DEFAULT 0 CHECK (blind_allowed IN (0, 1)),
  coverage_boxes_json TEXT CHECK (coverage_boxes_json IS NULL OR json_type(coverage_boxes_json) = 'array'),
  PRIMARY KEY (batch_id, item_id)
);
