import { describe, expect, it } from "vitest";
import type { Json } from "../src/json";
import { readAccountsAnswer, readSyncPage } from "../src/plaid/sync-answers";
import { GOOD_ACCOUNT, GOOD_PAGE, GOOD_TRANSACTION } from "./sync-page-corpus";

// The sync's two Plaid answers are checked at the edge (#1152): what makes the sync fail today is refused with a plain
// Error before a statement is built, and everything the sync takes today is taken, as sent.

/** A value as Plaid sends it: through JSON, so a field left undefined is left out. */
const sent = <T>(value: T): Json => JSON.parse(JSON.stringify(value));

describe("readSyncPage", () => {
	it("gives a good page as sent", () => {
		expect(readSyncPage(sent(GOOD_PAGE))).toEqual(GOOD_PAGE);
	});

	it.each([
		["null", null],
		["an array", []],
		["text", "page"],
		["no added", { ...GOOD_PAGE, added: undefined }],
		["a modified that is not a list", { ...GOOD_PAGE, modified: {} }],
		["no removed", { ...GOOD_PAGE, removed: undefined }],
		[
			"a charge with no date",
			{ ...GOOD_PAGE, added: [{ ...GOOD_TRANSACTION, date: undefined }] },
		],
		[
			"a charge with no name",
			{ ...GOOD_PAGE, added: [{ ...GOOD_TRANSACTION, name: undefined }] },
		],
		[
			"a charge whose amount is text",
			{ ...GOOD_PAGE, added: [{ ...GOOD_TRANSACTION, amount: "12.34" }] },
		],
		["a removed charge with no id", { ...GOOD_PAGE, removed: [{}] }],
	])("refuses %s with a plain Error", (_name, page) => {
		expect(() => readSyncPage(sent(page))).toThrow(Error);
		expect(() => readSyncPage(sent(page))).not.toThrow(TypeError);
	});

	it("takes what the sync takes today", () => {
		for (const page of [
			{ ...GOOD_PAGE, has_more: undefined },
			{ ...GOOD_PAGE, next_cursor: null },
			{ ...GOOD_PAGE, next_cursor: 5 },
			{ ...GOOD_PAGE, next_cursor: undefined, has_more: true },
			{ ...GOOD_PAGE, extra: { a: [1] } },
			{ ...GOOD_PAGE, added: [{ ...GOOD_TRANSACTION, transaction_id: null }] },
			{ ...GOOD_PAGE, added: [{ ...GOOD_TRANSACTION, pending: undefined }] },
			{
				...GOOD_PAGE,
				modified: [{ ...GOOD_TRANSACTION, account_id: undefined }],
			},
			{ ...GOOD_PAGE, removed: [{ transaction_id: 5 }] },
			// A name of another type fails the sync only beside a merchant that is not blank (the code review of #1170).
			{
				...GOOD_PAGE,
				added: [{ ...GOOD_TRANSACTION, merchant_name: null, name: 5 }],
			},
		])
			expect(readSyncPage(sent(page))).toEqual(page);
	});
});

describe("readAccountsAnswer", () => {
	it("gives the accounts as sent", () => {
		expect(readAccountsAnswer(sent({ accounts: [GOOD_ACCOUNT] }))).toEqual([
			GOOD_ACCOUNT,
		]);
	});

	it.each([
		["null", null],
		["no accounts", {}],
		["accounts that is not a list", { accounts: {} }],
		["a null account", { accounts: [null] }],
		["no name", { accounts: [{ ...GOOD_ACCOUNT, name: undefined }] }],
		["no type", { accounts: [{ ...GOOD_ACCOUNT, type: undefined }] }],
		["null balances", { accounts: [{ ...GOOD_ACCOUNT, balances: null }] }],
		["no balances", { accounts: [{ ...GOOD_ACCOUNT, balances: undefined }] }],
		["no id", { accounts: [{ ...GOOD_ACCOUNT, account_id: undefined }] }],
	])("refuses %s with a plain Error", (_name, answer) => {
		expect(() => readAccountsAnswer(sent(answer))).toThrow(Error);
		expect(() => readAccountsAnswer(sent(answer))).not.toThrow(TypeError);
	});

	it("takes a name or mask that arrives as a number", () => {
		const accounts = [{ ...GOOD_ACCOUNT, name: 5, mask: 12 }];
		expect(readAccountsAnswer(sent({ accounts }))).toEqual(accounts);
	});
});
