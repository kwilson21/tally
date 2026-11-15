import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	readBankSignInEmails,
	saveBankSignInEmails,
} from "../src/db/reconnect";

// The Bank sign-in emails switch (decision 149): on until someone turns it off, and read as on when unset.

beforeEach(async () => {
	await env.DB.prepare(
		"DELETE FROM household_settings WHERE key = 'bank_sign_in_emails'",
	).run();
});

describe("the bank sign-in emails switch", () => {
	it("reads as on when no row is stored", async () => {
		expect(await readBankSignInEmails(env.DB)).toBe(true);
	});

	it("keeps the last value saved, with one row for the key", async () => {
		await saveBankSignInEmails(env.DB, false);
		await saveBankSignInEmails(env.DB, true);

		expect(await readBankSignInEmails(env.DB)).toBe(true);

		const { results } = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'bank_sign_in_emails'",
		).all<{ value: string }>();

		expect(results).toEqual([{ value: "on" }]);
	});
});
