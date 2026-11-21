-- Version 1 used the logical pair order. Version 2 records the rendered physical order.
ALTER TABLE synth_ranking_answers ADD COLUMN mapping_version INTEGER NOT NULL DEFAULT 1
  CHECK (mapping_version IN (1, 2));
