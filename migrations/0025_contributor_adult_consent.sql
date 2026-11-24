-- Preserve existing minors' consent and submissions while allowing adult self-consent.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE contributor_enrolments_new (
  writer_id TEXT PRIMARY KEY,
  writer_account TEXT NOT NULL UNIQUE,
  guardian_account TEXT,
  age_band TEXT NOT NULL CHECK(age_band IN ('10_12','13_15','16_17','18_plus')),
  split TEXT NOT NULL CHECK(split IN ('train','dev','eval_open')),
  receipt TEXT NOT NULL UNIQUE,
  guardian_version TEXT,
  guardian_sha256 TEXT,
  guardian_at TEXT,
  assent_version TEXT,
  assent_sha256 TEXT,
  assent_at TEXT,
  withdrawn_at TEXT,
  purged_at TEXT,
  CHECK((age_band = '18_plus' AND guardian_account IS NULL
    AND guardian_version IS NULL AND guardian_sha256 IS NULL AND guardian_at IS NULL)
    OR (age_band <> '18_plus' AND guardian_account IS NOT NULL AND writer_account <> guardian_account))
);

CREATE TABLE contributor_submissions_new (
  writer_id TEXT NOT NULL REFERENCES contributor_enrolments_new(writer_id),
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('print','form','line','handwriting')),
  policy_version TEXT NOT NULL,
  policy_licence TEXT NOT NULL CHECK(policy_licence='cc0_open'),
  guardian_sha256 TEXT,
  assent_sha256 TEXT NOT NULL,
  reference_sha256 TEXT,
  content_sha256 TEXT NOT NULL UNIQUE,
  storage_key TEXT UNIQUE,
  review_result_json TEXT,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY(writer_id, task_id),
  CHECK((kind IN ('form','handwriting'))=(reference_sha256 IS NOT NULL)),
  CHECK((kind='line')=(review_result_json IS NOT NULL)),
  CHECK((kind<>'line')=(storage_key IS NOT NULL))
);

INSERT INTO contributor_enrolments_new SELECT * FROM contributor_enrolments;
INSERT INTO contributor_submissions_new SELECT * FROM contributor_submissions;
DROP TABLE contributor_submissions;
DROP TABLE contributor_enrolments;
ALTER TABLE contributor_enrolments_new RENAME TO contributor_enrolments;
ALTER TABLE contributor_submissions_new RENAME TO contributor_submissions;
