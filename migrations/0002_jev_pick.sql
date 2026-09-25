-- Jev's category pick, kept even when it's below the threshold, so the threshold can be tuned
-- from real picks (decision 29). Null when Jev hasn't answered or said none of the categories fit.
ALTER TABLE transactions ADD COLUMN jev_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
