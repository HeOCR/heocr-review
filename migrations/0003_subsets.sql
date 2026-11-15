-- Named subsets of a batch's proposals that a reviewer can choose to work through on their own (a filter on the
-- queue). Membership only: proposals, their content hashes, ranks, gates and decisions are untouched, and exports do
-- not read these tables. Members are named by proposal external_id, so they survive a re-import of the batch.
--   A subset is a list of strata. Each stratum serves one member at a time: the first, in position order (0 = the
--   pick, then its alternates), whose proposal is active and has no current rejection (or a confirm with no
--   reference line), so a rejected pick is replaced by its next alternate.
CREATE TABLE subsets (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  id TEXT NOT NULL,                          -- e.g. interim_v1
  title TEXT NOT NULL,                       -- shown in the app's filter
  source_sha256 TEXT NOT NULL,               -- the definition file the members came from
  imported_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, id)
);

CREATE TABLE subset_members (
  batch_id TEXT NOT NULL,
  subset_id TEXT NOT NULL,
  stratum TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  external_id TEXT NOT NULL,
  PRIMARY KEY (batch_id, subset_id, stratum, position),
  UNIQUE (batch_id, subset_id, external_id),
  FOREIGN KEY (batch_id, subset_id) REFERENCES subsets(batch_id, id)
);
