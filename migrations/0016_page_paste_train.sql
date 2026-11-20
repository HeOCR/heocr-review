-- Training page transcription is independent of line-review items, proposals and decisions.
CREATE TABLE page_paste_train_pages (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  page_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  image_json TEXT NOT NULL,
  line_boxes_json TEXT NOT NULL CHECK (json_type(line_boxes_json) = 'array'),
  asset_parts INTEGER NOT NULL CHECK (asset_parts > 0),
  UNIQUE (batch_id, position),
  UNIQUE (batch_id, page_key)
);

CREATE TABLE page_paste_train_assets (
  page_id INTEGER NOT NULL REFERENCES page_paste_train_pages(id),
  part INTEGER NOT NULL CHECK (part >= 0),
  base64 TEXT NOT NULL,
  PRIMARY KEY (page_id, part)
);

CREATE TABLE page_paste_train_decisions (
  page_id INTEGER PRIMARY KEY REFERENCES page_paste_train_pages(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  page_text TEXT NOT NULL,
  entered_count INTEGER NOT NULL CHECK (entered_count >= 0),
  alignment_mismatch INTEGER NOT NULL CHECK (alignment_mismatch IN (0, 1)),
  terms_version TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX page_paste_train_reviewer ON page_paste_train_decisions (reviewer_id);
