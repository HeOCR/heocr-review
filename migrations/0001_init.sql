-- HeOCR Review: task types -> batches of items -> proposals -> decisions.
-- Task types live in code (src/tasks/registry.ts); a batch names its task type.
-- No email addresses or names from the identity provider are ever stored.

CREATE TABLE batches (
  id TEXT PRIMARY KEY,                       -- the source's id, e.g. the audit_id e2d4_reference_audit_v1
  task_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_json TEXT NOT NULL,                 -- task-type metadata about the imported file
  min_reviewers INTEGER NOT NULL DEFAULT 1 CHECK (min_reviewers >= 1),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  imported_at TEXT NOT NULL
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  external_id TEXT NOT NULL,                 -- e.g. wikisource_he_proofread:ws_index_1725257__p0003
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (batch_id, external_id)
);

CREATE TABLE proposals (
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  external_id TEXT NOT NULL,                 -- e.g. e2d4-ws_index_1725257__p0003-001
  category TEXT NOT NULL,
  confidence TEXT NOT NULL,
  rank INTEGER NOT NULL,                     -- serving order: easiest, highest confidence first
  payload_json TEXT NOT NULL,
  media_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,              -- of the payload; a decision on other content is stale
  active INTEGER NOT NULL DEFAULT 1,         -- 0 when a re-import dropped it
  UNIQUE (batch_id, external_id)
);
CREATE INDEX proposals_queue ON proposals (batch_id, active, rank);

CREATE TABLE reviewers (
  id TEXT PRIMARY KEY,                       -- rv_xxxxxxxx, a keyed pseudonym of the provider subject
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  terms_version TEXT,
  terms_accepted_at TEXT,
  display_name TEXT,                         -- only with explicit consent; NULL by default
  display_name_consented_at TEXT,
  blocked INTEGER NOT NULL DEFAULT 0
);

-- Every consent given or withdrawn, with its version and time.
CREATE TABLE consent_events (
  id INTEGER PRIMARY KEY,
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  kind TEXT NOT NULL CHECK (kind IN ('contribution_terms', 'display_name_credit', 'display_name_withdrawn')),
  terms_version TEXT NOT NULL,
  value TEXT,
  created_at TEXT NOT NULL
);

-- Every decision of every reviewer. A reviewer's later decision on the same proposal supersedes (never deletes)
-- their earlier one.
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,                       -- hr-<16 hex>; exported as hocrgen decision_id
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  value TEXT NOT NULL,
  text TEXT,
  proposal_sha256 TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_on TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  superseded_at TEXT
);
CREATE UNIQUE INDEX decisions_one_current ON decisions (proposal_id, reviewer_id) WHERE superseded_at IS NULL;
CREATE INDEX decisions_reviewer ON decisions (reviewer_id, superseded_at);

CREATE TABLE skips (
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (reviewer_id, proposal_id)
);

-- A short lease on the proposal a reviewer was just served, so concurrent reviewers spread over the queue.
CREATE TABLE assignments (
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  assigned_at INTEGER NOT NULL,              -- unix ms
  PRIMARY KEY (proposal_id, reviewer_id)
);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,                         -- "<bucket>:<reviewer id or keyed hash of the client address>"
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
