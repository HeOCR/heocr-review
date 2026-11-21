-- Apply to the dedicated intake D1 binding only.
CREATE TABLE hw_pages (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  writer TEXT NOT NULL UNIQUE,
  writer_account TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL UNIQUE,
  receipt TEXT NOT NULL UNIQUE,
  prompt_hash TEXT NOT NULL,
  current_version TEXT,
  withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0,1))
);
CREATE UNIQUE INDEX hw_live_slot ON hw_pages(slot) WHERE withdrawn=0;

CREATE TABLE hw_tokens (
  hash TEXT PRIMARY KEY,
  page TEXT NOT NULL REFERENCES hw_pages(id),
  replaces TEXT,
  expires INTEGER NOT NULL,
  original_sha TEXT,
  version TEXT
);
CREATE TABLE hw_consent (
  version TEXT PRIMARY KEY,
  page TEXT NOT NULL REFERENCES hw_pages(id),
  language TEXT NOT NULL,
  wording_version TEXT NOT NULL,
  wording_sha TEXT NOT NULL,
  agreed_at INTEGER NOT NULL
);
CREATE TABLE hw_versions (
  id TEXT PRIMARY KEY,
  page TEXT NOT NULL REFERENCES hw_pages(id),
  parent TEXT,
  sha TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','cleared','quarantined','retired')),
  geometry TEXT,
  screened_by TEXT,
  screened_at INTEGER,
  split TEXT NOT NULL DEFAULT 'pending' CHECK(split IN ('pending','clear','overlap')),
  UNIQUE(page,sha)
);
CREATE INDEX hw_version_page ON hw_versions(page);

CREATE TABLE hw_geometry (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL REFERENCES hw_versions(id),
  parent TEXT,
  page_sha TEXT NOT NULL
);
CREATE TABLE hw_lines (
  id TEXT PRIMARY KEY,
  geometry TEXT NOT NULL REFERENCES hw_geometry(id),
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 10),
  polygon TEXT NOT NULL,
  sha TEXT NOT NULL,
  UNIQUE(geometry,position)
);
CREATE TABLE hw_reader_consent (
  reviewer TEXT NOT NULL,
  wording_version TEXT NOT NULL,
  language TEXT NOT NULL,
  wording_sha TEXT NOT NULL,
  agreed_at INTEGER NOT NULL,
  PRIMARY KEY(reviewer,wording_version,wording_sha)
);
CREATE TABLE hw_reads (
  line TEXT NOT NULL REFERENCES hw_lines(id) ON DELETE CASCADE,
  reviewer TEXT NOT NULL,
  pass INTEGER NOT NULL CHECK(pass BETWEEN 1 AND 3),
  raw TEXT NOT NULL,
  normalized TEXT NOT NULL,
  issue TEXT NOT NULL,
  wording_version TEXT NOT NULL,
  wording_sha TEXT NOT NULL,
  PRIMARY KEY(line,pass),
  UNIQUE(line,reviewer)
);
CREATE TABLE hw_resolution (
  line TEXT PRIMARY KEY REFERENCES hw_lines(id) ON DELETE CASCADE,
  reference TEXT,
  reason TEXT
);
CREATE TABLE hw_candidates (
  sha TEXT PRIMARY KEY,
  manifest TEXT NOT NULL,
  invalid INTEGER NOT NULL DEFAULT 0 CHECK(invalid IN (0,1))
);
CREATE TABLE hw_candidate_pages (
  candidate TEXT NOT NULL REFERENCES hw_candidates(sha) ON DELETE CASCADE,
  page TEXT NOT NULL REFERENCES hw_pages(id),
  geometry TEXT NOT NULL REFERENCES hw_geometry(id),
  PRIMARY KEY(candidate,page)
);

CREATE VIEW hw_active_lines AS
SELECT l.id,l.geometry,l.position,l.polygon,l.sha,p.id AS page,p.writer_account,p.slot,p.prompt_hash,v.id AS version
FROM hw_lines l
JOIN hw_geometry g ON g.id=l.geometry
JOIN hw_versions v ON v.id=g.version AND v.geometry=g.id
JOIN hw_pages p ON p.id=v.page AND p.current_version=v.id
WHERE p.withdrawn=0 AND v.state='cleared' AND v.split='clear';
