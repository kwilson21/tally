import { setup } from "xstate";

// The retry of one transaction's Jev question (decision 182, #864). A row Jev fails on JEV_ATTEMPT_CAP times in a row
// gives up: the sorting run leaves it out until a person asks again, or the row's bank text, name, amount or account
// changes. Jev's answer ends a waiting row's category question: a row with a category (filed) is never reopened, and an
// unsure row (Jev stored a confidence and set no category) is still asked about its income question, so its failures
// count too. This machine is the one place that says so. The SQL writers keep the database's columns in step with it
// (the SQL forms below are the same rules), and test/jev-attempt-cap.test.ts walks every writer from every state against the machine.

/** How many failures in a row Jev may have on one transaction before it gives up (decision 182). */
export const JEV_ATTEMPT_CAP = 5;

export type JevRetryState = "waiting" | "gave_up" | "unsure" | "filed";

/**
 * The row's own values the guards and transitions read. `categorized` is whether Jev's answer came back with a
 * category, which decides between filed and unsure for a waiting row. `answered` is whether a confidence is stored,
 * which decides where a gave-up row goes when its bank text changes.
 */
export type JevRetryContext = {
	attempts: number;
	categorized: boolean;
	answered: boolean;
};

const initialContext: JevRetryContext = {
	attempts: 0,
	categorized: false,
	answered: false,
};

export const jevRetry = setup({}).createMachine({
	id: "jevRetry",
	initial: "waiting",
	context: initialContext,
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
				// The trigger resets the counter on a change. A row with a stored answer keeps it, so it is unsure again;
				// a row with none waits.
				ROW_CHANGED: ({ context }) =>
					context.answered
						? { target: "unsure", context: { attempts: 0 } }
						: { target: "waiting", context: { attempts: 0 } },
			},
		},
		unsure: {
			on: {
				// Still asked about its income question, so a failure counts exactly as it does while waiting.
				JEV_FAILED: ({ context }) =>
					context.attempts + 1 >= JEV_ATTEMPT_CAP
						? { target: "gave_up", context: { attempts: context.attempts + 1 } }
						: { target: "unsure", context: { attempts: context.attempts + 1 } },
				// An answer to the income question is a success: the count starts over. The category question is not
				// asked again, so the row stays unsure.
				JEV_ANSWERED: { target: "unsure", context: { attempts: 0 } },
				ASK_AGAIN: { target: "waiting", context: { attempts: 0 } },
				// The trigger resets only the counter, so an unsure answer stays. Whether a changed row should also
				// reopen an unsure answer is an open question for the owner (decision 182); until it is decided, it stays.
				ROW_CHANGED: { target: "unsure", context: { attempts: 0 } },
			},
		},
		// A filed row refuses every event: no transition is listed, so the machine never leaves it.
		filed: {},
	},
});

/**
 * The state a stored row is in, from its retry columns, checked in this order. Filed is any row with a category,
 * whoever set it. Gave up is the counter at the cap, which wins over unsure. Unsure is a stored confidence with no
 * category. Every other row is waiting.
 */
export function retryStateOf(row: {
	attempts: number;
	categoryId: number | null;
	categorySource: string | null;
	confidence: number | null;
}): JevRetryState {
	if (row.categoryId !== null) return "filed";

	if (row.attempts >= JEV_ATTEMPT_CAP) return "gave_up";

	if (row.confidence !== null) return "unsure";

	return "waiting";
}

// The SQL forms of the same states, for one table alias. Each is true exactly when retryStateOf names that state, with
// gave_up checked first: `gaveUpSql` is true for an unsure row at the cap too.

/** True for a filed row: any row with a category. */
export function filedSql(alias: string): string {
	return `(${alias}.category_id IS NOT NULL)`;
}

/** True for a row that has given up. Pending work leaves these out, and the answer writer refuses them. */
export function gaveUpSql(alias: string): string {
	return `(${alias}.jev_attempts >= ${JEV_ATTEMPT_CAP} AND NOT ${filedSql(alias)})`;
}

/**
 * True for a row Jev is still asked about, waiting or unsure: the rows a failed ask counts against. A filed row and a
 * row that has given up are not.
 */
export function openSql(alias: string): string {
	return `(NOT ${filedSql(alias)} AND NOT ${gaveUpSql(alias)})`;
}
