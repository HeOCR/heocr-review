-- Admin-only development review. Bytes stay in D1 and are served through the signed-in trial.
CREATE TABLE synth_realism_assets (
  sha256 TEXT NOT NULL,
  part INTEGER NOT NULL,
  base64 TEXT NOT NULL,
  PRIMARY KEY (sha256, part)
);
CREATE TABLE synth_realism_items (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  external_id TEXT NOT NULL,
  synthetic_image TEXT NOT NULL,
  synthetic_line_crop TEXT NOT NULL,
  real_ref_image TEXT NOT NULL,
  real_ref_line_crop TEXT NOT NULL,
  generator_id TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  control_kind TEXT NOT NULL CHECK (control_kind IN ('standard', 'real_real', 'attention')),
  UNIQUE (batch_id, external_id),
  UNIQUE (id, batch_id)
);
CREATE TABLE synth_realism_trials (
  id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  swapped INTEGER NOT NULL CHECK (swapped IN (0, 1)),
  served_at INTEGER NOT NULL,
  choice INTEGER CHECK (choice IN (0, 1)),
  chosen_at INTEGER,
  latency_ms INTEGER,
  score INTEGER CHECK (score BETWEEN 0 AND 10),
  tags_json TEXT,
  comment TEXT,
  completed_at INTEGER,
  FOREIGN KEY (item_id, batch_id) REFERENCES synth_realism_items(id, batch_id),
  UNIQUE (item_id, reviewer_id)
);
CREATE UNIQUE INDEX synth_realism_one_active
  ON synth_realism_trials(batch_id, reviewer_id) WHERE completed_at IS NULL;
CREATE INDEX synth_realism_trials_batch ON synth_realism_trials(batch_id, reviewer_id);
