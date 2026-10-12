-- Decision 103 (#360, #450): before #450 every Workers AI note call was marked tried, including a failed call and a
--   batch dropped when Fill in details was turned off, so a note Jev said was worth writing was never asked again.
--   From #450 a tried row isn't asked again, so each empty, undismissed note that Jev said is worth writing gets one
--   more try here. Only note_tried_at changes: updated_by and updated_at stay as they were, since this is a data fix,
--   not an edit. A note a person emptied themselves is asked once more too, and a guess stays dashed until it is
--   kept or dismissed. A row Jev answered with NULL or 0 is not touched, so no note is written for it.
UPDATE transactions SET note_tried_at = NULL WHERE note_tried_at IS NOT NULL AND details_asked = 1 AND note_worth_writing = 1 AND note_dismissed = 0 AND (note IS NULL OR trim(note) = '');
