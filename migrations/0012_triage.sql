-- Triage mode (the maintainer, 2026-11-20): in a line_verify batch set to 'triage', a line with a candidate is answered
-- on any screen with one of three answers, never edited there: correct (the candidate is the line), different (it
-- goes to the desktop fix queue), niqqud_mismatch (pointed print in an unpointed batch). "different" is a decision row
-- like any other; the fix the reviewer makes on the desktop supersedes it (the row is kept, superseded_at set).
-- heocr-eval's rules: heocr-restricted-eval#153 (reference_triage_v1). 'standard' (the default) changes nothing.
ALTER TABLE batch_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'triage'));
