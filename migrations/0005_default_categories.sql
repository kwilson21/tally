-- Every new database starts with the same categories, adapted from the owner's earlier app
-- (spec §7, decision 32). Only a database with no categories gets them: the demo keeps its seed,
-- and a household's own categories are never touched. No budgets: the family sets those.
INSERT INTO categories (name, icon, color, sort_order)
SELECT column1, column2, column3, column4 FROM (VALUES
  ('Groceries', 'groceries', 'cat-blue', 1),
  ('Eating Out', 'eating-out', 'cat-plum', 2),
  ('Gas', 'gas', 'cat-slate', 3),
  ('Car & Transport', 'car', 'cat-ochre', 4),
  ('Rent', 'rent', 'cat-brown', 5),
  ('Utilities', 'utilities', 'cat-blue', 6),
  ('Subscriptions', 'subscriptions', 'cat-plum', 7),
  ('Shopping', 'shopping', 'cat-slate', 8),
  ('Personal Care', 'personal-care', 'cat-ochre', 9),
  ('Health', 'health', 'cat-brown', 10),
  ('Entertainment', 'entertainment', 'cat-blue', 11),
  ('Kids', 'kids', 'cat-plum', 12),
  ('Date Night', 'date-night', 'cat-slate', 13),
  ('Donations & Charity', 'donations', 'cat-ochre', 14)
)
WHERE NOT EXISTS (SELECT 1 FROM categories);
