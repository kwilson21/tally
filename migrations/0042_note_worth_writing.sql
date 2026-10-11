-- Jev's yes/no on whether a "what it was" line could say more than the store's name (decision 103): 1 yes, 0 no,
-- NULL until Jev has been asked. Workers AI writes a note only for a 1, so a 0 or NULL means no call.
ALTER TABLE transactions ADD COLUMN note_worth_writing INTEGER CHECK (note_worth_writing IN (0, 1));
