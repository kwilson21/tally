-- One explicit state for each transaction's "what it was" note (the note pipeline, src/db/note-state.ts). It replaces
-- reading note_guessed, note_tried_at, note_failed_at, note_dismissed and note_worth_writing together. The old columns stay
-- for now, and nothing decides from them any more; dropping them is a follow-up.
ALTER TABLE transactions ADD COLUMN note_state TEXT NOT NULL DEFAULT 'unasked'
  CHECK (note_state IN ('unasked', 'unanswered', 'no_call', 'queued', 'failed', 'tried_empty', 'emptied_by_person', 'guessed', 'written', 'dismissed'));

-- A guess copied onto a row a person had already dismissed (the pending-to-posted merge) left both flags set. The
-- dismissal wins, so the guess goes and the row reads as dismissed. This runs before the backfill below.
UPDATE transactions SET note = NULL, note_guessed = 0 WHERE note_guessed = 1 AND note_dismissed = 1;

-- Backfill from the flags. The first matching line wins. A row a person emptied is never queued: a try on a row Jev did not
-- say yes to, or on a row Jev never asked, can only have come from the person's edit, so it is emptied_by_person.
UPDATE transactions SET note_state = CASE
  WHEN trim(COALESCE(note, '')) != '' AND note_guessed = 1 THEN 'guessed'
  WHEN trim(COALESCE(note, '')) != ''                     THEN 'written'
  WHEN note_dismissed = 1                                 THEN 'dismissed'
  WHEN note_tried_at IS NOT NULL AND NOT (details_asked = 1 AND note_worth_writing IS 1) THEN 'emptied_by_person'
  WHEN note_tried_at IS NOT NULL                          THEN 'tried_empty'
  WHEN details_asked = 0                                  THEN 'unasked'
  WHEN note_worth_writing = 0                             THEN 'no_call'
  WHEN note_worth_writing IS NULL                         THEN 'unanswered'
  WHEN note_failed_at IS NOT NULL                         THEN 'failed'
  ELSE 'queued'
END;
