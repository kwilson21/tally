// Who is still on the first week's pages (decisions 146 and 149). Home's first-week setup and the questions page post a
// check-in every HOME_SEEN_EVERY_MS while they are open, and the ready email goes to a person only once no check-in has
// come for EMAIL_AWAY_AFTER_MS. A tab that isn't on screen counts as away (decision 149, the owner's pick): home-seen.js
// cancels the check-in while the tab is hidden, so a background tab, or a minimized window, does not keep someone there.

/** How often an open first-week page checks in (the check-in element, src/views/home-seen.tsx). */
export const HOME_SEEN_EVERY_MS = 30_000;

/** How long after its last check-in a person counts as away, so the ready email is sent to them (ready-email.tsx). */
export const EMAIL_AWAY_AFTER_MS = 600_000;

/** How long after its last check-in a person counts as away, so the ready push is sent to each of their devices (ready-push.ts). */
export const PUSH_AWAY_AFTER_MS = 120_000;

/** How long after a delivered ready push its person's ready email waits, so the push is seen first (ready-email.tsx). */
export const EMAIL_AFTER_PUSH_MS = 480_000;
