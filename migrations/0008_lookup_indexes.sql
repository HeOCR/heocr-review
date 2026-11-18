-- Lookups the queue runs per proposal (2026-11-18): a page_review page's volunteer twin is found by its items'
-- external_id and its proposals' item_id, which had no index of their own (preview's D1 hit its CPU limit).
CREATE INDEX IF NOT EXISTS items_external_id ON items (external_id);
CREATE INDEX IF NOT EXISTS proposals_item ON proposals (item_id);
