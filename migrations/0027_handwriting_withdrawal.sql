-- Keep the assignment audit and receipt lookup separate from the account-linked enrolment.
ALTER TABLE contributor_handwriting_roster ADD COLUMN withdrawal_receipt_sha256 TEXT;
CREATE UNIQUE INDEX contributor_handwriting_withdrawal_receipt
  ON contributor_handwriting_roster(withdrawal_receipt_sha256) WHERE withdrawal_receipt_sha256 IS NOT NULL;

-- Retain only the sign-in account's opt-out. It has no writer code or assignment link.
ALTER TABLE reviewers ADD COLUMN handwriting_opted_out INTEGER NOT NULL DEFAULT 0
  CHECK(handwriting_opted_out IN (0,1));

-- Exact released originals and the confirmed public manifest that contains them.
-- These pins survive deletion of the submission and enrolment records.
CREATE TABLE contributor_handwriting_publications (
  content_sha256 TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  release_sha256 TEXT NOT NULL
);

-- The operator uses this view to select unpublished sources for review and release.
CREATE VIEW contributor_handwriting_release_candidates AS
  SELECT s.*, r.config_sha256, r.split
  FROM contributor_submissions s
  JOIN contributor_enrolments e USING(writer_id)
  JOIN contributor_handwriting_roster r USING(writer_id)
  WHERE s.kind='handwriting' AND e.withdrawn_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM contributor_handwriting_publications p
      WHERE p.content_sha256=s.content_sha256);
