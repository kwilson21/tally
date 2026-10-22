// Who is still on the first week's pages (decision 146). Home's first-week setup and the questions page post a check-in
// every HOME_SEEN_EVERY_MS while they are open, and the ready email goes to a person only once no check-in has come for
// EMAIL_AWAY_AFTER_MS. A laptop's background tab may keep checking in about once a minute (browsers slow timers in
// background tabs), so it counts as there until it is closed.

/** How often an open first-week page checks in (the check-in element, src/views/home-seen.tsx). */
export const HOME_SEEN_EVERY_MS = 30_000;

/** How long after its last check-in a person counts as away, so the ready email is sent to them (ready-email.tsx). */
export const EMAIL_AWAY_AFTER_MS = 600_000;
