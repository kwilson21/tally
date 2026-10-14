import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveAskedNames } from "../src/db/merchant-names";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { tidyName } from "../src/transactions/tidy-name";

// Names Workers AI suggested are saved under each bank text (spec §7). When Plaid later gives several bank
// texts one merchant name in one sync, on any of its pages, sync starts that merchant's row from their rows: each
// choice a person made (a name, a rule, Not a bill) comes from the first text that has it, and the suggestion comes
// from one row. Workers AI is
// asked only about texts Plaid doesn't name (decision 68), and a Plaid name that is only the text tidied has
// nothing to suggest (decision 79), so a guess made for a text is not left waiting on the merchant Plaid
// named, whichever text's row it was on.

const KEY = btoa("01234567890123456789012345678901");
const T1 = "TARGET 1234";
const T2 = "TARGET #55";
// Plaid's name for both, which is only each text tidied, so Plaid has nothing to suggest and the names
// Workers AI made are what a person could still choose.
const PLAID = "Target";

const transaction = (
	id: string,
	name: string,
	merchantName: string | null,
) => ({
	transaction_id: id,
	account_id: "account-1",
	date: "2026-09-27",
	amount: 6.5,
	name,
	merchant_name: merchantName,
	pending: false,
	personal_finance_category: { primary: "FOOD_AND_DRINK" },
});

const response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

async function addItem() {
	const encrypted = await encryptToken("secret-access-token", KEY);
	const result = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(encrypted, crypto.randomUUID())
		.first<{ id: number }>();
	return result?.id as number;
}

const ACCOUNT = {
	account_id: "account-1",
	name: "Everyday",
	mask: "1234",
	type: "depository",
	subtype: "checking",
	balances: { current: 10 },
};

type Page = {
	added?: unknown[];
	hasMore?: boolean;
};

/** A sync over these pages, in order, on the one account. */
async function syncPages(id: number, pages: Page[]) {
	let served = 0;
	const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get")) {
			return response({ accounts: [ACCOUNT] });
		}
		const page = pages[served++] ?? {};
		return response({
			added: page.added ?? [],
			modified: [],
			removed: [],
			next_cursor: crypto.randomUUID(),
			has_more: page.hasMore ?? false,
		});
	});
	await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
}

/** A sync whose one page holds these transactions. */
const sync = (id: number, added: unknown[]) => syncPages(id, [{ added }]);

const row = (key: string) =>
	env.DB.prepare(
		"SELECT suggested_name, display_name, suggestion_status FROM merchants WHERE raw_name = ?",
	)
		.bind(key)
		.first<{
			suggested_name: string | null;
			display_name: string | null;
			suggestion_status: string;
		}>();

const GUESSES = "Target Stores\nTarget Corp";

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
});

describe("a guess made for a bank text does not wait on the merchant Plaid names", () => {
	it("takes the other text's guess over the empty answer, then clears it, since Plaid's name is only the text tidied", async () => {
		const id = await addItem();
		await env.DB.batch([
			// Asked about, nothing usable: the empty answer that stops it being asked again.
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		// The waiting guess is the bare suggestion, so the shared key copies it; the page then clears it as stale.
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
		// The text's own row keeps its guess for any charge that still has no Plaid name.
		expect((await row(T2))?.suggestion_status).toBe("pending");
	});

	it("keeps the other text's name, rule and Not a bill on the shared key when the empty answer comes first", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Tea', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My tea', ?, 1)",
			).bind(T2, category?.id),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(
			await env.DB.prepare(
				"SELECT display_name, default_category_id, not_a_bill FROM merchants WHERE raw_name = ?",
			)
				.bind(PLAID)
				.first(),
		).toEqual({
			display_name: "My tea",
			default_category_id: category?.id,
			not_a_bill: 1,
		});
	});

	it("ends with a person's name from one bank text and a rule from the other on the shared key", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Snacks', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
			).bind(T2, category?.id),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(
			await env.DB.prepare(
				"SELECT display_name, default_category_id FROM merchants WHERE raw_name = ?",
			)
				.bind(PLAID)
				.first(),
		).toEqual({ display_name: "My coffee", default_category_id: category?.id });
	});

	it("takes a decided suggestion over the empty answer that comes first, with its name and status together", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Old Guess', 'rejected')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "Old Guess",
			display_name: null,
			suggestion_status: "rejected",
		});
	});

	it("takes a decided suggestion over a bare guess that comes first, with its name and status together", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T1, GUESSES),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Old Guess', 'rejected')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "Old Guess",
			display_name: null,
			suggestion_status: "rejected",
		});
	});

	it("never copies a waiting guess onto a merchant a person named, when the guess's text comes first", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T1, GUESSES),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: "My coffee",
			suggestion_status: "none",
		});
	});

	it("never copies a waiting guess onto a merchant a person named, when the named text holds only the empty answer", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T1, GUESSES),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, suggested_name, suggestion_status) VALUES (?, 'My coffee', '', 'none')",
			).bind(T2),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "",
			display_name: "My coffee",
			suggestion_status: "none",
		});
	});

	it("clears the guess copied from a text's row, whichever text comes first", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
		)
			.bind(T2, GUESSES)
			.run();
		// T1 has no row at all, so T2's is the one copied.
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
	});

	it("clears the first row's guess when both have some", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'First Names', 'pending')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
	});

	it("copies the first text that has a row, even when an earlier text has none", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
		)
			.bind(T2)
			.run();
		// T1 comes first and has no row; T2's is the first there is, so its name carries over.
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({ display_name: "My coffee" });
	});

	it("copies the configured row of the second text when the first text's name call failed, so a failure leaves no row to copy", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Coffee', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		// T1's name call failed. The failure is kept apart from merchants (#468), so T1 gets no row here.
		await saveAskedNames(env.DB, [], [T1]);
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My coffee', ?, 1)",
		)
			.bind(T2, category?.id)
			.run();
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({ display_name: "My coffee" });
		expect(
			await env.DB.prepare(
				"SELECT default_category_id, not_a_bill FROM merchants WHERE raw_name = ?",
			)
				.bind(PLAID)
				.first(),
		).toEqual({ default_category_id: category?.id, not_a_bill: 1 });
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM merchants WHERE raw_name = ?",
			)
				.bind(T1)
				.first(),
		).toEqual({ n: 0 });
	});

	it("never changes a suggestion a person already decided, or a name a person chose", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Old Guess', 'rejected')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({ suggestion_status: "rejected" });

		await env.DB.batch([
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES (?, 'My coffee')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T2, GUESSES),
		]);
		await sync(id, [transaction("c", T1, PLAID), transaction("d", T2, PLAID)]);
		expect(await row(PLAID)).toMatchObject({
			display_name: "My coffee",
			suggestion_status: "none",
		});
	});

	it("leaves a merchant that has no waiting names on any text as it was", async () => {
		const id = await addItem();
		await sync(id, [transaction("a", T1, PLAID), transaction("b", T2, PLAID)]);
		expect(await row(PLAID)).toBeNull();
	});
});

const choices = (key: string) =>
	env.DB.prepare(
		"SELECT display_name, default_category_id, not_a_bill FROM merchants WHERE raw_name = ?",
	)
		.bind(key)
		.first();

// A shared merchant name whose bank texts come on different pages of one sync. Within one
// sync, a later page fills in a choice the shared row doesn't have yet, and a better-ranked suggestion; a row an
// earlier sync made is never touched.
describe("a shared merchant name keeps each person's choice when its bank texts come on different pages of one sync", () => {
	it("keeps the name, rule and Not a bill of a page-two text when page one's text holds only the empty answer", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Hobbies', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My tea', ?, 1)",
			).bind(T2, category?.id),
		]);
		await syncPages(id, [
			{ added: [transaction("a", T1, PLAID)], hasMore: true },
			{ added: [transaction("b", T2, PLAID)] },
		]);
		expect(await choices(PLAID)).toEqual({
			display_name: "My tea",
			default_category_id: category?.id,
			not_a_bill: 1,
		});
	});

	// Page one's key is made by Plaid's name suggestion, not by a copy: 'TGT 0412' has no row, and its tidied name
	// ('Tgt') isn't 'Target', so 'Target' is suggested. Page two's text, T2, has the name, rule and Not a bill. Reading
	// the open keys from the copy's RETURNING would miss 'Target', since the suggestion made it, so the open set is read
	// before each page instead.
	it("gives the key page one's suggestion made the name, rule and Not a bill of page two's text, as one page does", async () => {
		expect(tidyName("TGT 0412")).not.toBe(PLAID);
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Books', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My tea', ?, 1)",
		)
			.bind(T2, category?.id)
			.run();
		await syncPages(id, [
			{ added: [transaction("a", "TGT 0412", PLAID)], hasMore: true },
			{ added: [transaction("b", T2, PLAID)] },
		]);
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: "My tea",
			suggestion_status: "none",
		});
		expect(await choices(PLAID)).toEqual({
			display_name: "My tea",
			default_category_id: category?.id,
			not_a_bill: 1,
		});
	});

	// The one-page version of the test above: both charges come on one page, so the page's copy sees both texts and
	// gives the same row. Whatever the pages, the result is what one page would give.
	it("gives the same row when both bank texts come on one page", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Stationery', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My tea', ?, 1)",
		)
			.bind(T2, category?.id)
			.run();
		await sync(id, [
			transaction("a", "TGT 0412", PLAID),
			transaction("b", T2, PLAID),
		]);
		expect(await row(PLAID)).toEqual({
			suggested_name: null,
			display_name: "My tea",
			suggestion_status: "none",
		});
		expect(await choices(PLAID)).toEqual({
			display_name: "My tea",
			default_category_id: category?.id,
			not_a_bill: 1,
		});
	});

	it("never copies a waiting guess onto a key page one made for a person's name", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name, suggested_name, suggestion_status) VALUES (?, 'My coffee', '', 'none')",
			).bind(T2),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, 'pending')",
			).bind(T1, GUESSES),
		]);
		// The '' and 'none' are what tell the outcomes apart: a copied guess would read as pending with its names.
		await syncPages(id, [
			{ added: [transaction("a", T2, PLAID)], hasMore: true },
			{ added: [transaction("b", T1, PLAID)] },
		]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "",
			display_name: "My coffee",
			suggestion_status: "none",
		});
	});

	it("takes a decided suggestion on page two over the empty answer on page one", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
			).bind(T1),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, 'Old Guess', 'rejected')",
			).bind(T2),
		]);
		await syncPages(id, [
			{ added: [transaction("a", T1, PLAID)], hasMore: true },
			{ added: [transaction("b", T2, PLAID)] },
		]);
		expect(await row(PLAID)).toEqual({
			suggested_name: "Old Guess",
			display_name: null,
			suggestion_status: "rejected",
		});
	});

	it("never fills a row an earlier sync made, even when a later sync brings a text with a name, rule and Not a bill", async () => {
		const id = await addItem();
		const category = await env.DB.prepare(
			"INSERT INTO categories (name, icon, color) VALUES ('Gifts', 'tag', 'cat-blue') RETURNING id",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, '', 'none')",
		)
			.bind(T1)
			.run();
		await syncPages(id, [{ added: [transaction("a", T1, PLAID)] }]);
		expect(await choices(PLAID)).toEqual({
			display_name: null,
			default_category_id: null,
			not_a_bill: 0,
		});

		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id, not_a_bill) VALUES (?, 'My tea', ?, 1)",
		)
			.bind(T2, category?.id)
			.run();
		// A second sync is a new run: the row the first one made is not open, so nothing is copied onto it.
		await syncPages(id, [{ added: [transaction("b", T2, PLAID)] }]);
		expect(await choices(PLAID)).toEqual({
			display_name: null,
			default_category_id: null,
			not_a_bill: 0,
		});
	});
});
