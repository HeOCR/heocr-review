-- line_verify volunteer resolution v1 (docs/specs/line_verify_volunteer_resolution_v1.md, 2026-11-18).

-- Per batch: 'single' (today's behaviour) or 'volunteer_v1' (two counted decisions per line, in-app routing).
ALTER TABLE batch_settings ADD COLUMN resolution TEXT NOT NULL DEFAULT 'single' CHECK (resolution IN ('single', 'volunteer_v1'));

-- One row per decision on a volunteer_v1 line, written when the decision is recorded and never recomputed: whether it
-- counted (the reviewer's mid-century standing then, or the maintainer step), why not, its routing step, and whether
-- an admin made it. Deleting a decision (reviewer deletion, class U) deletes its row.
CREATE TABLE verify_votes (
  decision_id TEXT PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  not_counted_reason TEXT CHECK (not_counted_reason IS NULL OR not_counted_reason IN ('fewer_than_20_gold', 'below_floor', 'excluded_by_admin')),
  step TEXT NOT NULL CHECK (step IN ('pass1', 'pass2', 'third', 'maintainer', 'fourth', 'uncounted')),
  by_admin INTEGER NOT NULL CHECK (by_admin IN (0, 1)),
  CHECK ((counted = 1) = (step <> 'uncounted')),
  CHECK ((counted = 1) = (not_counted_reason IS NULL))
);
CREATE INDEX verify_votes_proposal ON verify_votes (proposal_id);

-- Each volunteer_v1 line's routing, recomputed by the Worker when a decision on it is recorded. No row: no counted
-- decision yet (pending, open to anyone).
CREATE TABLE verify_state (
  proposal_id INTEGER PRIMARY KEY REFERENCES proposals(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  resolution TEXT NOT NULL CHECK (resolution IN ('agreed', 'majority', 'to_maintainer', 'unresolved', 'pending')),
  open_to TEXT NOT NULL CHECK (open_to IN ('anyone', 'admin', 'non_admin', 'nobody')),
  updated_at TEXT NOT NULL
);
CREATE INDEX verify_state_queue ON verify_state (batch_id, open_to);
