-- Machine agreement is pinned review routing, never a human decision.
CREATE TABLE reference_consensus_runs (
  projection_sha256 TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id),
  items_sha256 TEXT NOT NULL,
  ratification_sha256 TEXT NOT NULL,
  rows_expected INTEGER NOT NULL CHECK(rows_expected > 0),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1))
);

CREATE TABLE reference_consensus_lines (
  projection_sha256 TEXT NOT NULL REFERENCES reference_consensus_runs(projection_sha256),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  proposal_sha256 TEXT NOT NULL,
  crop_key TEXT NOT NULL,
  page_key TEXT NOT NULL,
  line_box TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('ordinary', 'audit', 'accepted')),
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(proposal_id, projection_sha256),
  UNIQUE(projection_sha256, lane, position)
);

CREATE VIEW current_reference_consensus_lines AS
SELECT r.batch_id, l.proposal_id, l.lane, l.position, l.projection_sha256
FROM reference_consensus_lines l
JOIN reference_consensus_runs r ON r.projection_sha256=l.projection_sha256
JOIN batches b ON b.id=r.batch_id
JOIN proposals p ON p.id=l.proposal_id AND p.batch_id=b.id AND p.item_id=l.item_id
WHERE r.active=1 AND p.active=1 AND b.restricted_reference=1 AND b.task_type='line_verify'
  AND json_extract(b.source_json,'$.restricted_review')='draft_verification'
  AND json_extract(b.source_json,'$.items_sha256')=r.items_sha256
  AND p.content_sha256=l.proposal_sha256
  AND json_extract(p.media_json,'$.crop.ref.source')='r2'
  AND json_extract(p.media_json,'$.page.ref.source')='r2'
  AND json_extract(p.media_json,'$.crop.ref.key')=l.crop_key
  AND json_extract(p.media_json,'$.page.ref.key')=l.page_key
  AND json_extract(p.payload_json,'$.box')=l.line_box;
