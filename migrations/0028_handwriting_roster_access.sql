-- Service access only. No request payloads, tokens, or participant data.
CREATE TABLE contributor_handwriting_roster_access (
  id INTEGER PRIMARY KEY,
  principal TEXT NOT NULL CHECK(principal='eval-operator'),
  method TEXT NOT NULL CHECK(method IN ('GET','POST')),
  requested_at_ms INTEGER NOT NULL
);
CREATE INDEX contributor_handwriting_roster_access_window
  ON contributor_handwriting_roster_access(method, requested_at_ms);
