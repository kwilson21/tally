// How long an Undo stays open. Every Undo (a cash delete, a plan delete, "Not this one", a Forget and the re-sort's) shares
// one toast and one countdown animation, so they share one window, and it is written only here. The server's checks,
// the words a person reads and the toast's countdown follow it; test/undo-window.test.ts fails if a copy comes back,
// including the two that cannot import this file (public/js/toast.js and the CSS token in src/styles/app.css).

/** How long an Undo stays open after the toast that offers it, in milliseconds (decision 101: ten seconds). */
export const UNDO_MS = 10_000;

/** The same window in seconds, for the words a person reads. */
export const UNDO_SECONDS = UNDO_MS / 1000;

/** A message with the Undo's window said after it: "Plan deleted. Undo for 10 seconds." */
export const undoWords = (what: string) =>
	`${what} Undo for ${UNDO_SECONDS} seconds.`;

/** The time left on an Undo begun at `startedAt`, read at `now`, in milliseconds: none once it has run out. */
export const undoLeftMs = (startedAt: number, now: number) =>
	Math.max(0, Math.min(UNDO_MS, startedAt + UNDO_MS - now));
