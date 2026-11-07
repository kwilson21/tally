import { setup } from "xstate";

// The retry of one transaction's Jev question (decision 171, #864). A row Jev fails on JEV_ATTEMPT_CAP times in a row
// gives up: the sorting run leaves it out until a person asks again, or the row's bank text, name, amount or account
// changes. Jev's answer ends the question: a filed row (Jev set a category) is never reopened, and an unsure row (Jev
// stored a confidence but set no category) waits for a person's ask again. This machine is the one place that says so.
// The SQL writers keep the database's columns in step with it (the SQL forms below are the same rules), and the tests
// walk every writer from every state against the machine.

/** How many failures in a row Jev may have on one transaction before it gives up (decision 171). */
export const JEV_ATTEMPT_CAP = 5;

export type JevRetryState = "waiting" | "gave_up" | "unsure" | "filed";

/**
 * The row's own values the guards and transitions read. `categorized` is whether Jev's answer came back with a
 * category, which is what JEV_ANSWERED decides between filed and unsure.
 */
export type JevRetryContext = { attempts: number; categorized: boolean };

export const jevRetry = setup({}).createMachine({
	id: "jevRetry",
	initial: "waiting",
	context: { attempts: 0, categorized: false } as JevRetryContext,
	states: {
		waiting: {
			on: {
				// One more failure. The one that reaches the cap gives up; the rest keep waiting.
				JEV_FAILED: ({ context }) =>
					context.attempts + 1 >= JEV_ATTEMPT_CAP
						? { target: "gave_up", context: { attempts: context.attempts + 1 } }
						: {
								target: "waiting",
								context: { attempts: context.attempts + 1 },
							},
				JEV_ANSWERED: ({ context }) =>
					context.categorized
						? { target: "filed", context: { attempts: 0 } }
						: { target: "unsure", context: { attempts: 0 } },
				ASK_AGAIN: { target: "waiting", context: { attempts: 0 } },
				ROW_CHANGED: { target: "waiting", context: { attempts: 0 } },
			},
		},
		gave_up: {
			on: {
				ASK_AGAIN: { target: "waiting", context: { attempts: 0 } },
				// The trigger resets the counter on a change, so the row waits again.
				ROW_CHANGED: { target: "waiting", context: { attempts: 0 } },
			},
		},
		unsure: {
			on: {
				ASK_AGAIN: { target: "waiting", context: { attempts: 0 } },
				// The trigger resets only the counter, so an unsure answer stays. Whether a changed row should also
				// reopen an unsure answer is an open question for the owner (decision 171); until it is decided, it stays.
				ROW_CHANGED: { target: "unsure", context: { attempts: 0 } },
			},
		},
		// A filed row refuses every event: no transition is listed, so the machine never leaves it.
		filed: {},
	},
});

/**
 * The state a stored row is in, from its retry columns. Filed is a category Jev set. Unsure is a stored confidence with
 * no category. Gave up is the counter at the cap for anything else. Every other row is waiting.
 */
export function retryStateOf(row: {
	attempts: number;
	categoryId: number | null;
	categorySource: string | null;
	confidence: number | null;
}): JevRetryState {
	if (row.categoryId !== null && row.categorySource === "jev") return "filed";
	if (row.confidence !== null && row.categoryId === null) return "unsure";
	if (row.attempts >= JEV_ATTEMPT_CAP) return "gave_up";
	return "waiting";
}

// The SQL forms of the same states, for one table alias. Each is true exactly when retryStateOf names that state.
// `IS 'jev'` keeps the test free of NULL, so a NULL source is simply not Jev's.

/** True for a filed row. */
export function filedSql(alias: string): string {
	return `(${alias}.category_id IS NOT NULL AND ${alias}.category_source IS 'jev')`;
}

/** True for an unsure row. */
export function unsureSql(alias: string): string {
	return `(${alias}.category_confidence IS NOT NULL AND ${alias}.category_id IS NULL)`;
}

/** True for a row that has given up. Pending work leaves these out, and the answer writer refuses them. */
export function gaveUpSql(alias: string): string {
	return `(${alias}.jev_attempts >= ${JEV_ATTEMPT_CAP} AND NOT ${filedSql(alias)} AND NOT ${unsureSql(alias)})`;
}

/** True for a waiting row: the only state a failed ask counts against. */
export function waitingSql(alias: string): string {
	return `(NOT ${filedSql(alias)} AND NOT ${unsureSql(alias)} AND NOT ${gaveUpSql(alias)})`;
}
