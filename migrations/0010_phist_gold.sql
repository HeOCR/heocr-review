-- line_verify P-hist gold (docs/specs/line_verify_phist_gold_v1_1.md, 2026-11-19).
--
-- SQLite cannot widen a CHECK in place, so batch_settings and verify_votes are rebuilt with their rows (both small:
-- one row per batch, and one per decision on a volunteer batch). Indexes are recreated.
PRAGMA defer_foreign_keys = true;

-- resolution gains 'volunteer_v1_1': volunteer_v1 plus the P-hist gold gate.
CREATE TABLE batch_settings_new (
  batch_id TEXT PRIMARY KEY REFERENCES batches(id),
  pass2_reviewer TEXT NOT NULL DEFAULT 'same' CHECK (pass2_reviewer IN ('same', 'other')),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  two_typings_groups TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(two_typings_groups) AND json_type(two_typings_groups) = 'array'),
  two_typings_set_at TEXT,
  resolution TEXT NOT NULL DEFAULT 'single' CHECK (resolution IN ('single', 'volunteer_v1', 'volunteer_v1_1'))
);
INSERT INTO batch_settings_new (batch_id, pass2_reviewer, updated_at, updated_by, two_typings_groups, two_typings_set_at, resolution)
  SELECT batch_id, pass2_reviewer, updated_at, updated_by, two_typings_groups, two_typings_set_at, resolution FROM batch_settings;
DROP TABLE batch_settings;
ALTER TABLE batch_settings_new RENAME TO batch_settings;

-- not_counted_reason gains the second gate's two reasons.
CREATE TABLE verify_votes_new (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  not_counted_reason TEXT CHECK (not_counted_reason IS NULL OR not_counted_reason IN
    ('fewer_than_20_gold', 'below_floor', 'excluded_by_admin', 'fewer_than_15_phist_gold', 'below_phist_floor')),
  step TEXT NOT NULL CHECK (step IN ('pass1', 'pass2', 'third', 'maintainer', 'fourth', 'uncounted')),
  by_admin INTEGER NOT NULL CHECK (by_admin IN (0, 1)),
  CHECK ((counted = 1) = (step <> 'uncounted')),
  CHECK ((counted = 1) = (not_counted_reason IS NULL))
);
INSERT INTO verify_votes_new (decision_id, proposal_id, counted, not_counted_reason, step, by_admin)
  SELECT decision_id, proposal_id, counted, not_counted_reason, step, by_admin FROM verify_votes;
DROP TABLE verify_votes;
ALTER TABLE verify_votes_new RENAME TO verify_votes;
CREATE INDEX verify_votes_proposal ON verify_votes (proposal_id);

-- One row per decision on a P-hist gold line, graded when it is made and never regraded. Deleting the decision
-- (reviewer deletion) deletes its row.
CREATE TABLE phist_gold_grades (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  gold_id TEXT NOT NULL,
  hit INTEGER NOT NULL CHECK (hit IN (0, 1)),
  graded_at TEXT NOT NULL
);
CREATE INDEX phist_gold_grades_reviewer ON phist_gold_grades (reviewer_id, gold_id);

-- Gold lines an admin pulled (a wrong answer): not served, and not counted in anyone's standing from pulled_at on.
-- Un-pulling sets pulled = 0. Both are forward-only: decisions already recorded keep what they stored.
CREATE TABLE phist_gold_pulls (
  gold_id TEXT PRIMARY KEY,
  pulled INTEGER NOT NULL CHECK (pulled IN (0, 1)),
  reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
