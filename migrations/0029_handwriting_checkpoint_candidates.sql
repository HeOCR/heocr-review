-- Operator review and eval approval of split use are separate requirements.
-- This view excludes quarantined submissions whose writer has no roster checkpoint.
DROP VIEW contributor_handwriting_release_candidates;
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
