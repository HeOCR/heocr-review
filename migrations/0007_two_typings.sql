-- heocr-eval's registered fallback for the P-hist hold-out (2026-11-18): if typed lines' word disagreement in the blind
-- sample exceeds 5% in a book group, every typed line (line_verify kind "type", pass 1) of that group needs a second
-- independent typing. two_typings_groups: a JSON list of the batch's book_group ids that need two; default none.
ALTER TABLE batch_settings ADD COLUMN two_typings_groups TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(two_typings_groups) AND json_type(two_typings_groups) = 'array');
ALTER TABLE batch_settings ADD COLUMN two_typings_set_at TEXT;
