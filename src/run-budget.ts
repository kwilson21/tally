// How long the night's Workers AI steps may keep starting requests (spec §7, src/sort-instance.ts). A step past its
// deadline starts nothing new and ends, and whatever isn't asked waits for the next night.

/** When a step starts nothing more, on the clock `now` reads (milliseconds; `Date.now` by default). */
export type Deadline = { deadline: number; now?: () => number };

/** True once `time`'s deadline has come; with no `time`, never. */
export const pastDeadline = (time?: Deadline) =>
	time !== undefined && (time.now ?? Date.now)() >= time.deadline;

/** Counted from the step's start. A Workflow step has no wall-clock limit, but these steps have a 15-minute timeout, and a request to Workers AI is given up on after 15 seconds (src/ai/suggest-name.ts), so a step that starts nothing after 13 minutes is done by about 13 minutes 15 seconds, inside it. */
export const runTimeBudgetMs = 13 * 60_000;
