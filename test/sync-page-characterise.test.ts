import { describe, expect, it } from "vitest";
import baseline from "./fixtures/sync-page-baseline.json";
import { answerOf } from "./sync-page-answers";
import { syncCases } from "./sync-page-corpus";

// Every case in sync-page-corpus.ts, run through the real syncItem. fixtures/sync-page-baseline.json holds each answer,
// recorded on the code before the accounts answer and the page were read with Effect Schema (#1152). A conversion must not
// move any answer: a sync that ends still ends with the same bank row, accounts and charges, and one that fails still fails
// with nothing written. A failure's class and message are not part of the answer.

const recorded: Record<string, string> = baseline;

// The one thing the conversion moves on purpose, named here and nowhere else. A bank's accounts answer that the sync cannot
// take (no name, type, balances or id, or an account that is text) used to fail the run only after the page was asked for,
// when the first account's statement was built. It now fails as soon as the accounts answer is read, so Plaid is not asked
// for the page (page asks 1 becomes 0). Either way the run fails, nothing is written and the cursor stays where it was.
const ACCOUNTS_FAIL_BEFORE_THE_PAGE = [
	"account | account_id | missing",
	"account | name | missing",
	"account | name | null",
	"account | type | missing",
	"account | type | null",
	"account | balances | missing",
	"account | balances | null",
	"accounts | holds text",
];

/** What the case answers now: as recorded, except where the conversion moves it on purpose. */
function wanted(label: string) {
	const was = recorded[label] ?? "";

	return ACCOUNTS_FAIL_BEFORE_THE_PAGE.includes(label)
		? was.replace("page asks 1", "page asks 0")
		: was;
}

describe("the sync's two Plaid answers are taken as they were before (#1152)", () => {
	it("gives every corpus case the answer recorded for it", async () => {
		const list = syncCases();
		const labels = list.map((item) => item.label);

		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.keys(recorded).sort()).toEqual([...labels].sort());

		const problems: string[] = [];

		for (const item of list) {
			const got = await answerOf(item);

			if (got !== wanted(item.label))
				problems.push(
					`${item.label}\n  want ${wanted(item.label)}\n  got  ${got}`,
				);
		}

		expect(problems).toEqual([]);
	}, 900_000);

	it("names only cases that failed before, after the page was asked for", () => {
		for (const label of ACCOUNTS_FAIL_BEFORE_THE_PAGE) {
			expect(recorded[label]).toMatch(/^fails .* page asks 1$/);
		}
	}, 900_000);
});
