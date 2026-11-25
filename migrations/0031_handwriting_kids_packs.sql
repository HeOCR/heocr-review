-- Handwriting v3 kids' cohort (restricted-eval #960, allocation amendment 3): a kid's roster row keeps its primary
-- set in set_id (E, C or D) and records the per-band slot it took and the second set of its 8-sheet pack.
-- Slots are never reused: withdrawal keeps the roster row. Adult rows leave both columns NULL.
ALTER TABLE contributor_handwriting_roster ADD COLUMN kids_slot INTEGER CHECK(kids_slot > 0);
ALTER TABLE contributor_handwriting_roster ADD COLUMN kids_second_set TEXT CHECK(kids_second_set IN ('A','B','F','G'));
CREATE UNIQUE INDEX contributor_handwriting_kids_slot
  ON contributor_handwriting_roster(config_sha256, age_band, kids_slot) WHERE kids_slot IS NOT NULL;

DROP VIEW contributor_handwriting_release_candidates;
CREATE VIEW contributor_handwriting_release_candidates AS
  SELECT s.*, r.config_sha256, r.split
  FROM contributor_submissions s
  JOIN contributor_enrolments e USING(writer_id)
  JOIN contributor_handwriting_roster r USING(writer_id)
  WHERE s.kind='handwriting' AND e.withdrawn_at IS NULL
    AND e.split=r.split AND e.age_band=r.age_band
    AND (s.task_id GLOB ('HW-V3-' || r.set_id || '0[1-4]')
      OR (r.kids_second_set IS NOT NULL AND s.task_id GLOB ('HW-V3-' || r.kids_second_set || '0[1-4]')))
    AND EXISTS (SELECT 1 FROM contributor_handwriting_pins pin
      WHERE pin.config_sha256=r.config_sha256 AND pin.through_ordinal>=r.ordinal)
    AND NOT EXISTS (SELECT 1 FROM contributor_handwriting_publications p
      WHERE p.content_sha256=s.content_sha256);
