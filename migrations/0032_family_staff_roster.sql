-- Handwriting v3 family-staff cohort (restricted-eval #2035, allocation amendment 6): adults on a separate pinned
-- plan, apart from the v3 roster and its capacities. The signup slot fixes the split. Withdrawal keeps the row, so a
-- slot is never reused. These rows are not release candidates: nothing here can be published until a later change.
CREATE TABLE contributor_family_staff_roster (
  config_sha256 TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(slot > 0),
  invite_sha256 TEXT NOT NULL,
  writer_id TEXT NOT NULL UNIQUE,
  split TEXT NOT NULL CHECK(split IN ('train','dev')),
  withdrawal_receipt_sha256 TEXT UNIQUE,
  PRIMARY KEY(config_sha256, slot)
);
