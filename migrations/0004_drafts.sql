-- A reviewer's unsaved page corrections (task type page_review), kept on the server so a reload, a crash or another
-- device does not lose them. One per reviewer and proposal, pinned to the pre-fill it was made on (a draft for another
-- pre-fill is never restored, and is deleted when found). Not a decision: never exported, never counted in progress,
-- never part of a reference; deleted when the reviewer confirms or rejects the page. Proposals and decisions are
-- untouched.
CREATE TABLE drafts (
  reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  prefill_sha256 TEXT NOT NULL,
  body TEXT NOT NULL,                        -- JSON {readingOrder, rows: [{src, action, text, looked}]}
  updated_at TEXT NOT NULL,
  PRIMARY KEY (reviewer_id, proposal_id)
);
