-- Triage mode (the maintainer, 2026-11-20): in a line_verify batch set to 'triage', a line with a candidate is answered
-- on any screen with one of three answers, never edited there: correct (the candidate is the line), different (it
-- goes to the desktop fix queue), niqqud_mismatch (pointed print in an unpointed batch). "different" is a decision row
-- like any other; the fix the reviewer makes on the desktop supersedes it (the row is kept, superseded_at set).
-- heocr-eval's rules: heocr-restricted-eval#153 (reference_triage_v1). 'standard' (the default) changes nothing.
ALTER TABLE batch_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'triage'));

-- Planted errors (the maintainer's confirmation-error check, option (b); heocr-eval's reference_triage_v1 amendment 2,
-- heocr-restricted-eval#154). eval plants one OCR-like error in a seeded 2% of triage candidates and ratifies the list
-- (triage_plants.v1, by sha); scripts/import-plants.ts copies it here. Triage shows planted_text in place of the
-- candidate whose sha256 is candidate_sha256; any triage answer then sends the line to the desktop, which shows the true
-- candidate, and a triage answer on a plant is never a reference. Written by the admin script only, never by the app.
CREATE TABLE triage_plants (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  item_id TEXT NOT NULL,
  plant_type TEXT NOT NULL,
  position TEXT NOT NULL,                    -- eval's position, as JSON (a code-point offset, or e.g. ["ins", 10])
  planted_text TEXT NOT NULL,
  planted_sha256 TEXT NOT NULL,
  candidate_sha256 TEXT NOT NULL,
  plants_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, proposal_id)
);
CREATE INDEX triage_plants_proposal ON triage_plants (proposal_id);
