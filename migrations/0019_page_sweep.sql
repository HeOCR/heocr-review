ALTER TABLE decisions ADD COLUMN method TEXT NOT NULL DEFAULT 'line' CHECK(method IN ('line','page_sweep','line_unplanted'));
ALTER TABLE page_checks ADD COLUMN method TEXT NOT NULL DEFAULT 'line' CHECK(method IN ('line','page_sweep'));
