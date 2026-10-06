// How long the steps of a nightly run may keep starting calls (spec §7, src/index.tsx). A step that is
// past its deadline starts nothing new and ends, so one slow step can never use up the run's time and
// leave the next with none, and whatever isn't asked waits for the next run.

/** When a step starts nothing more, on the clock `now` reads (milliseconds; `Date.now` by default). */
export type Deadline = { deadline: number; now?: () => number };

/** True once `time`'s deadline has come; with no `time`, never. */
export const pastDeadline = (time?: Deadline) =>
	time !== undefined && (time.now ?? Date.now)() >= time.deadline;

/**
 * Both are counted from the start of the run. A cron run is cut off at 15 minutes of wall-clock time
 * (Cloudflare's Workers limits), a call to Jev is abandoned after 10 seconds (src/ai/categorize.ts) and a
 * request to Workers AI after 15 (src/ai/suggest-name.ts). So a step that starts nothing after 13 minutes
 * is done by about 13 minutes 15 seconds, inside the 15 (`runTimeBudgetMs`). Where a run asks Jev and then
 * names, Jev starts nothing after 9 minutes (`sortTimeBudgetMs`), which leaves the names about 4.
 */
export const sortTimeBudgetMs = 9 * 60_000;
export const runTimeBudgetMs = 13 * 60_000;
