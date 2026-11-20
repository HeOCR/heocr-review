-- A registered page's existing pass-1 lines can be submitted together by its assigned reviewer.
CREATE TABLE page_paste_pages (
  item_id INTEGER PRIMARY KEY REFERENCES items(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  line_pins_json TEXT NOT NULL,
  registration_sha256 TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  submitted_at TEXT,
  submission_id TEXT,
  submission_sha256 TEXT,
  UNIQUE (batch_id, ordinal)
);
CREATE INDEX page_paste_queue ON page_paste_pages(batch_id, reviewer_id, submitted_at, ordinal);

ALTER TABLE decisions ADD COLUMN correction_start TEXT CHECK (correction_start = 'page_paste');
ALTER TABLE triage_plants ADD COLUMN voided_at TEXT;
ALTER TABLE triage_plants ADD COLUMN void_reason TEXT CHECK (void_reason = 'page_paste');

-- This also stops an old tab already in flight when the page was registered.
CREATE TRIGGER page_paste_no_line_decision
BEFORE INSERT ON decisions
WHEN NEW.correction_start IS NULL AND EXISTS (
  SELECT 1 FROM proposals p JOIN page_paste_pages pp ON pp.item_id = p.item_id WHERE p.id = NEW.proposal_id
)
BEGIN
  SELECT RAISE(ABORT, 'proposal belongs to the page-paste queue');
END;

CREATE TRIGGER page_paste_no_new_plant
BEFORE INSERT ON triage_plants
WHEN EXISTS (
  SELECT 1 FROM proposals p JOIN page_paste_pages pp ON pp.item_id = p.item_id WHERE p.id = NEW.proposal_id
)
BEGIN
  SELECT RAISE(ABORT, 'proposal belongs to the page-paste queue');
END;

-- Record the void as part of the page registration itself, without removing the historical plant.
CREATE TRIGGER page_paste_void_plants
AFTER INSERT ON page_paste_pages
BEGIN
  UPDATE triage_plants SET voided_at = NEW.registered_at, void_reason = 'page_paste'
  WHERE batch_id = NEW.batch_id AND voided_at IS NULL
    AND proposal_id IN (SELECT id FROM proposals WHERE item_id = NEW.item_id);
END;
