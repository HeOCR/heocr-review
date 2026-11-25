-- Handwriting v3 set E, "שירה עברית" / "Hebrew poetry" (TRAIN). SQLite cannot widen a CHECK in place, so rebuild
-- the roster with the same columns, rows, indexes and dependent view. The roster is append-only and small.
DROP VIEW contributor_handwriting_release_candidates;

CREATE TABLE contributor_handwriting_roster_new (
  ordinal INTEGER PRIMARY KEY,
  config_sha256 TEXT NOT NULL,
  invite_sha256 TEXT NOT NULL,
  writer_id TEXT NOT NULL UNIQUE,
  set_id TEXT NOT NULL CHECK(set_id IN ('A','B','C','D','E')),
  age_band TEXT NOT NULL CHECK(age_band IN ('10_12','13_17','18_plus')),
  split TEXT NOT NULL CHECK(split IN ('train','dev','eval_open')),
  withdrawal_receipt_sha256 TEXT
);
INSERT INTO contributor_handwriting_roster_new
  (ordinal, config_sha256, invite_sha256, writer_id, set_id, age_band, split, withdrawal_receipt_sha256)
  SELECT ordinal, config_sha256, invite_sha256, writer_id, set_id, age_band, split, withdrawal_receipt_sha256
  FROM contributor_handwriting_roster;
DROP TABLE contributor_handwriting_roster;
ALTER TABLE contributor_handwriting_roster_new RENAME TO contributor_handwriting_roster;

CREATE INDEX contributor_handwriting_roster_config_invite
  ON contributor_handwriting_roster(config_sha256, invite_sha256);
CREATE UNIQUE INDEX contributor_handwriting_withdrawal_receipt
  ON contributor_handwriting_roster(withdrawal_receipt_sha256) WHERE withdrawal_receipt_sha256 IS NOT NULL;

CREATE VIEW contributor_handwriting_release_candidates AS
  SELECT s.*, r.config_sha256, r.split
  FROM contributor_submissions s
  JOIN contributor_enrolments e USING(writer_id)
  JOIN contributor_handwriting_roster r USING(writer_id)
  WHERE s.kind='handwriting' AND e.withdrawn_at IS NULL
    AND e.split=r.split AND e.age_band=r.age_band
    AND s.task_id GLOB ('HW-V3-' || r.set_id || '0[1-4]')
    AND EXISTS (SELECT 1 FROM contributor_handwriting_pins pin
      WHERE pin.config_sha256=r.config_sha256 AND pin.through_ordinal>=r.ordinal)
    AND NOT EXISTS (SELECT 1 FROM contributor_handwriting_publications p
      WHERE p.content_sha256=s.content_sha256);
