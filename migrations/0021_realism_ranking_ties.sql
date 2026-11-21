-- Widen the answer choice while preserving saved responses and undo revisions.
CREATE TABLE synth_ranking_answers_with_ties (
  batch_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  choice INTEGER CHECK (choice IN (0, 1, 2)),
  tie_available INTEGER NOT NULL DEFAULT 0 CHECK (tie_available IN (0, 1)),
  swapped INTEGER NOT NULL CHECK (swapped IN (0, 1)),
  latency_ms INTEGER,
  chosen_at INTEGER,
  CHECK ((choice IS NULL AND latency_ms IS NULL AND chosen_at IS NULL) OR
    (choice IS NOT NULL AND latency_ms IS NOT NULL AND latency_ms >= 0 AND chosen_at IS NOT NULL)),
  CHECK (choice <> 2 OR tie_available = 1),
  FOREIGN KEY (batch_id, position) REFERENCES synth_ranking_pairs(batch_id, position),
  PRIMARY KEY (batch_id, reviewer_id, position)
) WITHOUT ROWID;

INSERT INTO synth_ranking_answers_with_ties
  (batch_id, reviewer_id, position, revision, choice, swapped, latency_ms, chosen_at)
SELECT batch_id, reviewer_id, position, revision, choice, swapped, latency_ms, chosen_at
FROM synth_ranking_answers;

DROP TABLE synth_ranking_answers;
ALTER TABLE synth_ranking_answers_with_ties RENAME TO synth_ranking_answers;
