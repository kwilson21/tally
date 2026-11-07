import { setup } from "xstate";

// The retry of one transaction's Jev question (decision 171, #864): a row Jev fails on JEV_ATTEMPT_CAP times in a
// row is left out of the sorting run until a person asks again or the row's bank text, name, amount or account
// changes. This machine is the one place that says so; the SQL writers keep the database's counter (`jev_attempts`)
// in step with it, and the tests walk every writer against it.

/** How many failures in a row Jev may have on one transaction before it gives up (decision 171). */
export const JEV_ATTEMPT_CAP = 5;

export type JevRetryState = "waiting" | "gave_up" | "answered";

export type JevRetryContext = { attempts: number };

// A failure while waiting counts one more, and it is the failure that reaches the cap that gives up. Answers and
// fresh starts reset the count. A gave-up or answered row refuses a failure or an answer: no transition handles it.
export const jevRetry = setup({}).createMachine({
	id: "jevRetry",
	initial: "waiting",
	context: { attempts: 0 } as JevRetryContext,
	states: {
		waiting: {
			on: {
				JEV_FAILED: ({ context }) =>
					context.attempts + 1 >= JEV_ATTEMPT_CAP
						? { target: "gave_up", context: { attempts: context.attempts + 1 } }
						: {
								target: "waiting",
								context: { attempts: context.attempts + 1 },
							},
				JEV_ANSWERED: { target: "answered", context: { attempts: 0 } },
				ASK_AGAIN: { target: "waiting", context: { attempts: 0 } },
				ROW_CHANGED: { target: "waiting", context: { attempts: 0 } },
			},
		},
		gave_up: {
			on: {
				ASK_AGAIN: { target: "waiting", context: { attempts: 0 } },
				ROW_CHANGED: { target: "waiting", context: { attempts: 0 } },
			},
		},
		answered: {
			on: {
				ASK_AGAIN: { target: "waiting", context: { attempts: 0 } },
				ROW_CHANGED: { target: "waiting", context: { attempts: 0 } },
			},
		},
	},
});

/**
 * The state a stored row is in: answered when Jev's answer is stored (`category_confidence`, decision 27), gave up when
 * the counter has reached the cap, and waiting otherwise. Matches the machine's states on every row the writers make.
 */
export function retryStateOf(row: {
	attempts: number;
	answered: boolean;
}): JevRetryState {
	if (row.answered) return "answered";
	if (row.attempts >= JEV_ATTEMPT_CAP) return "gave_up";
	return "waiting";
}

/** The SQL that is true for a row the machine calls gave_up, for a table alias. Pending work leaves these out. */
export function gaveUpSql(alias: string): string {
	return `(${alias}.jev_attempts >= ${JEV_ATTEMPT_CAP} AND ${alias}.category_confidence IS NULL)`;
}
