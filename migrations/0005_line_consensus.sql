-- Volunteer line review (task type line_consensus, 2026-11-18). Every line goes to two volunteers; a disagreement
-- sends it to a third; no majority sends it to the maintainer (src/tasks/line_consensus/consensus.ts).

-- Each line's routing state, recomputed by the Worker when a decision on it is recorded or when a volunteer's
-- standing changes. state: open (needed > 0 more volunteers), waiting (a provisional volunteer's standing decides it),
-- agreed, majority, to_maintainer, no_box (no line box: the maintainer's from the start), maintainer (decided by the
-- maintainer). Gold lines have no row: they are served by the gold rule, never by state.
CREATE TABLE line_state (
  proposal_id INTEGER PRIMARY KEY REFERENCES proposals(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'agreed', 'majority', 'to_maintainer', 'no_box', 'maintainer')),
  needed INTEGER NOT NULL CHECK (needed BETWEEN 0 AND 2),
  updated_at TEXT NOT NULL
);
CREATE INDEX line_state_queue ON line_state (batch_id, state, needed);

-- An admin's switch: this reviewer's decisions in this batch do not count toward agreement (kept and exported).
-- Deleting a reviewer's record deletes their exclusions.
CREATE TABLE agreement_exclusions (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  excluded_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, reviewer_id)
);

-- Decisions an admin made in a volunteer batch (the maintainer's tie-breaks and no-box lines): exported with role
-- maintainer, never counted as a volunteer's.
CREATE TABLE maintainer_decisions (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id)
);
