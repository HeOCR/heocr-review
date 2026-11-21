-- Ranking uses separate immutable pairs and a single row per reviewer answer.
CREATE TABLE synth_ranking_pairs (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  position INTEGER NOT NULL CHECK (position > 0),
  pair_id TEXT NOT NULL,
  item_a TEXT NOT NULL,
  arm_a TEXT,
  image_a TEXT NOT NULL,
  item_b TEXT NOT NULL,
  arm_b TEXT,
  image_b TEXT NOT NULL,
  CHECK (item_a <> item_b AND image_a <> image_b),
  PRIMARY KEY (batch_id, position),
  UNIQUE (batch_id, pair_id)
) WITHOUT ROWID;

CREATE TABLE synth_ranking_answers (
  batch_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  choice INTEGER CHECK (choice IN (0, 1)),
  swapped INTEGER NOT NULL CHECK (swapped IN (0, 1)),
  latency_ms INTEGER,
  chosen_at INTEGER,
  CHECK ((choice IS NULL AND latency_ms IS NULL AND chosen_at IS NULL) OR
    (choice IS NOT NULL AND latency_ms IS NOT NULL AND latency_ms >= 0 AND chosen_at IS NOT NULL)),
  FOREIGN KEY (batch_id, position) REFERENCES synth_ranking_pairs(batch_id, position),
  PRIMARY KEY (batch_id, reviewer_id, position)
) WITHOUT ROWID;
