import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { namesToReview } from "../src/db/merchant-names";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { suggestMerchantNames } from "../src/suggest-names-pending";
import { fakeAi } from "./helpers/doubles";
import {
	assertMerchantInvariants,
	clearMerchants,
	merchantNames,
	seedMerchant,
	setMerchantNames,
} from "./helpers/merchants";
import { isMemberOf, isMethod, present } from "./helpers/present";

// Plaid's merchant name is the merchant's first suggested name (spec §8.6, decision 68, issue #194):
// sync stores it, with no AI call, and a person still has to choose it.

const KEY = btoa("01234567890123456789012345678901");

/** A JSON value, as a Plaid answer holds it. */
type Json = string | number | boolean | null | Json[] | JsonObject;

/** A JSON object; a field set to undefined is left out of the body, as JSON.stringify leaves it out. */
type JsonObject = { [key: string]: Json | undefined };

const transaction = (overrides: JsonObject = {}) => ({
	transaction_id: "transaction-1",
	account_id: "account-1",
	date: "2026-09-27",
	amount: 6.5,
	name: "SQ *BLUE BOTTLE COF 0412",
	merchant_name: "Blue Bottle Coffee",
	pending: false,
	personal_finance_category: { primary: "FOOD_AND_DRINK" },
	...overrides,
});

const response = (body: Json) =>
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

	return present(result).id;
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
	added?: JsonObject[];
	modified?: JsonObject[];
	/** Plaid transaction ids the bank removed. */
	removed?: string[];
	hasMore?: boolean;
};

/**
 * A sync over these pages, on the same account every time. `between(n)` runs once page n - 1 is saved,
 * just before page n is asked for. `db` is the database the sync sees.
 */
async function syncPages(
	id: number,
	pages: Page[],
	{
		db = env.DB,
		between,
	}: { db?: D1Database; between?: (page: number) => Promise<void> } = {},
) {
	let served = 0;

	const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
		if (String(url).endsWith("/accounts/get")) {
			return response({ accounts: [ACCOUNT] });
		}

		const index = served++;

		if (index > 0) await between?.(index);
		const page = pages[index] ?? {};

		return response({
			added: page.added ?? [],
			modified: page.modified ?? [],
			removed: (page.removed ?? []).map((transaction_id) => ({
				transaction_id,
			})),
			next_cursor: crypto.randomUUID(),
			has_more: page.hasMore ?? false,
		});
	});

	await syncItem({ ...env, DB: db, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl);
}

/** A sync whose one page holds these transactions. */
const sync = (
	id: number,
	page: Omit<Page, "hasMore"> & { db?: D1Database } = {},
) => syncPages(id, [page], { db: page.db });

/** The database, and how many statements the sync prepared on it (D1 allows 1,000 queries per invocation). */
function counting(db: D1Database) {
	let statements = 0;

	const counted = new Proxy(db, {
		get(target, property) {
			const value = isMemberOf(target, property) ? target[property] : undefined;

			if (property === "prepare") {
				return (sql: string) => {
					statements += 1;

					return target.prepare(sql);
				};
			}

			return isMethod(value) ? value.bind(target) : value;
		},
	});

	return { db: counted, statements: () => statements };
}

type MerchantRow = {
	raw_name: string;
	names: string[];
	display_name: string | null;
	suggestion_status: string;
};

/**
 * The names each merchant waiting for a person offers, one array per merchant, in order, for merchants that still have a
 * charge (the review lists no other).
 */
const pendingNames = async () => {
	const { results } = await env.DB.prepare(
		`SELECT raw_name FROM merchants
		 WHERE suggestion_status = 'pending'
		   AND EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_name = merchants.raw_name)
		 ORDER BY raw_name`,
	).all<{ raw_name: string }>();

	return Promise.all(results.map((row) => merchantNames(env.DB, row.raw_name)));
};

const merchants = async (): Promise<MerchantRow[]> => {
	const { results } = await env.DB.prepare(
		"SELECT raw_name, display_name, suggestion_status FROM merchants ORDER BY raw_name",
	).all<Omit<MerchantRow, "names">>();

	return Promise.all(
		results.map(async (row) => ({
			...row,
			names: await merchantNames(env.DB, row.raw_name),
		})),
	);
};

describe("Plaid's merchant name as the first name suggestion", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchant_suggested_names"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM household_settings WHERE key = 'ai_names'"),
		]);
	});

	it("suggests Plaid's name for a merchant whose shown name differs, pending, and renames nothing", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction()] });

		expect(await merchants()).toEqual([
			{
				raw_name: "Blue Bottle Coffee",
				names: ["Blue Bottle Coffee"],
				display_name: null,
				suggestion_status: "pending",
			},
		]);
	});

	it("keeps every name a waiting merchant offers, not only the first", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction()] });
		await setMerchantNames(env.DB, "Blue Bottle Coffee", [
			"Blue Bottle Coffee",
			"Blue Bottle",
			"Blue Bottle Cafe",
		]);
		expect(await pendingNames()).toEqual([
			["Blue Bottle Coffee", "Blue Bottle", "Blue Bottle Cafe"],
		]);
	});

	it("makes no suggestion when Plaid sent no merchant name, or a blank one", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				transaction({ transaction_id: "none", merchant_name: null }),
				transaction({ transaction_id: "blank", merchant_name: "  " }),
				transaction({ transaction_id: "missing", merchant_name: undefined }),
			],
		});
		expect(await merchants()).toEqual([]);
	});

	it("makes no suggestion when Plaid's name is what the list already shows", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				// The tidied bank text is "Target": nothing to suggest.
				transaction({
					transaction_id: "tidy",
					name: "TARGET 1234",
					merchant_name: "Target",
				}),
				// The bank text is already the name.
				transaction({
					transaction_id: "same",
					name: "Netflix",
					merchant_name: "Netflix",
				}),
			],
		});
		expect(await merchants()).toEqual([]);
	});

	it("still suggests a name that differs from the tidied text only in capitals", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				transaction({ name: "T-MOBILE 8812", merchant_name: "T-Mobile" }),
			],
		});
		expect((await merchants()).map((m) => m.names[0])).toEqual(["T-Mobile"]);
	});

	it("suggests it on a modified transaction too", async () => {
		const id = await addItem();
		await sync(id, {
			added: [transaction({ merchant_name: null })],
		});
		expect(await merchants()).toEqual([]);

		await sync(id, { modified: [transaction()] });
		expect(await merchants()).toMatchObject([
			{ raw_name: "Blue Bottle Coffee", suggestion_status: "pending" },
		]);
	});

	it("never replaces a name a person chose, and leaves its status alone", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, suggestion_status) VALUES ('Blue Bottle Coffee', 'The Bottle', 'none')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toEqual([
			{
				raw_name: "Blue Bottle Coffee",
				names: [],
				display_name: "The Bottle",
				suggestion_status: "none",
			},
		]);
	});

	it("does not suggest again to someone who already decided (accepted or rejected)", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('Blue Bottle Coffee', 'rejected', 0)",
			),
			env.DB.prepare(
				"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('Blue Bottle Coffee', 0, 'Blue Bottle Coffee')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('Lupitas', 'accepted', 0)",
			),
			env.DB.prepare(
				"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('Lupitas', 0, 'Lupitas')",
			),
		]);
		await sync(id, {
			added: [
				transaction(),
				transaction({
					transaction_id: "lupitas",
					name: "SQ *LUPITAS TAQ 2210",
					merchant_name: "Lupitas",
				}),
			],
		});
		expect((await merchants()).map((m) => m.suggestion_status)).toEqual([
			"rejected",
			"accepted",
		]);
	});

	it("puts Plaid's name in front of an older suggestion that is still waiting", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('Blue Bottle Coffee', 'pending', 0)",
		).run();
		await env.DB.prepare(
			"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('Blue Bottle Coffee', 0, 'Blue Bottle')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toMatchObject([
			{
				names: ["Blue Bottle Coffee"],
				suggestion_status: "pending",
			},
		]);
	});

	it("is the same row however many transactions bring the name", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				transaction({ transaction_id: "a", name: "SQ *BLUE BOTTLE COF 0412" }),
				transaction({ transaction_id: "b", name: "SQ *BLUE BOTTLE COF 0777" }),
			],
		});
		await sync(id, {
			added: [
				transaction({ transaction_id: "c", name: "BLUE BOTTLE OAKLAND" }),
			],
		});
		expect(await merchants()).toHaveLength(1);
	});

	it("gives a corrected Plaid name its own suggestion, so the newest name is the one the transaction shows", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction()] });
		await sync(id, {
			modified: [transaction({ merchant_name: "Blue Bottle" })],
		});
		// The charge's merchant is the newest name, and that merchant's suggestion is it.
		expect(await merchantNames(env.DB, "Blue Bottle")).toEqual(["Blue Bottle"]);
		// The name no charge carries any more is not asked about.
		expect(await pendingNames()).toEqual([["Blue Bottle"]]);
	});

	describe("one bank text with different Plaid names suggests the newest (decision 79)", () => {
		it("keeps a shared Plaid name while it is still newest for an untouched bank text", async () => {
			const id = await addItem();
			await syncPages(id, [
				{
					added: [
						transaction({
							transaction_id: "a",
							name: "TARGET STORE 1111",
							merchant_name: "Target",
						}),
						transaction({
							transaction_id: "b",
							name: "TARGET SHOP 2222",
							merchant_name: "Target",
						}),
					],
					hasMore: true,
				},
				{
					added: [
						transaction({
							transaction_id: "a-new",
							name: "TARGET STORE 1111",
							date: "2026-10-01",
							merchant_name: "Target Corp",
						}),
					],
				},
			]);

			expect(await pendingNames()).toEqual([["Target"], ["Target Corp"]]);
		});

		it("suggests the newer name when it arrives in a later sync, and withdraws the older one", async () => {
			const id = await addItem();
			await sync(id, {
				added: [
					transaction({
						transaction_id: "old",
						date: "2026-08-02",
						merchant_name: "Blue Bottle",
					}),
				],
			});
			expect(await pendingNames()).toEqual([["Blue Bottle"]]);
			await sync(id, {
				added: [
					transaction({
						transaction_id: "new",
						date: "2026-09-27",
						merchant_name: "Blue Bottle Coffee",
					}),
				],
			});
			expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);
			// The older name's merchant is untouched apart from its waiting suggestion.
			expect(await merchants()).toEqual([
				{
					raw_name: "Blue Bottle",
					names: [],
					display_name: null,
					suggestion_status: "none",
				},
				{
					raw_name: "Blue Bottle Coffee",
					names: ["Blue Bottle Coffee"],
					display_name: null,
					suggestion_status: "pending",
				},
			]);
		});

		it("suggests only the newer name when both arrive together, whichever comes first", async () => {
			const id = await addItem();

			const older = transaction({
				transaction_id: "old",
				date: "2026-08-02",
				merchant_name: "Blue Bottle",
			});

			const newer = transaction({
				transaction_id: "new",
				date: "2026-09-27",
				merchant_name: "Blue Bottle Coffee",
			});

			await sync(id, { added: [newer, older] });
			expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);
		});

		it("keeps the newer name when an older charge with the older name arrives afterwards", async () => {
			const id = await addItem();
			await sync(id, {
				added: [
					transaction({
						transaction_id: "new",
						date: "2026-09-27",
						merchant_name: "Blue Bottle Coffee",
					}),
				],
			});
			await sync(id, {
				added: [
					transaction({
						transaction_id: "old",
						date: "2026-08-02",
						merchant_name: "Blue Bottle",
					}),
				],
			});
			expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);
		});

		it("lets the same date go to the charge that came last", async () => {
			const id = await addItem();
			await sync(id, {
				added: [
					transaction({ transaction_id: "a", merchant_name: "Blue Bottle" }),
				],
			});
			await sync(id, {
				added: [
					transaction({
						transaction_id: "b",
						merchant_name: "Blue Bottle Coffee",
					}),
				],
			});
			expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);
		});

		it("suggests nothing when the newest name is only the bank's text tidied, and withdraws the older name", async () => {
			const id = await addItem();
			await sync(id, {
				added: [
					transaction({
						transaction_id: "old",
						date: "2026-08-02",
						name: "TARGET 1234",
						merchant_name: "Target Corp",
					}),
				],
			});
			expect(await pendingNames()).toEqual([["Target Corp"]]);
			// The newest charge's name says what the list already shows ("Target"), so there is nothing to suggest.
			await sync(id, {
				added: [
					transaction({
						transaction_id: "new",
						date: "2026-09-27",
						name: "TARGET 1234",
						merchant_name: "Target",
					}),
				],
			});
			expect(await pendingNames()).toEqual([]);
		});

		it("withdraws a name that only repeats its own bank text when another text has an older name", async () => {
			const id = await addItem();
			await sync(id, {
				added: [
					transaction({
						transaction_id: "target-corp",
						name: "TGT*0099",
						date: "2026-08-02",
						merchant_name: "Target Corp",
					}),
					transaction({
						transaction_id: "target",
						name: "TARGET 1234",
						date: "2026-09-27",
						merchant_name: "Target",
					}),
				],
			});

			expect(await merchants()).toEqual([
				{
					raw_name: "Target Corp",
					names: ["Target Corp"],
					display_name: null,
					suggestion_status: "pending",
				},
			]);
			expect(await namesToReview(env.DB)).toEqual([
				expect.objectContaining({
					key: "Target Corp",
					bankText: "TGT*0099",
					names: ["Target Corp"],
				}),
			]);
		});

		it("leaves a name that is the newest for another bank text", async () => {
			const id = await addItem();
			await sync(id, {
				added: [
					// "Blue Bottle" is the newest name for the Oakland text...
					transaction({
						transaction_id: "oakland",
						name: "BLUE BOTTLE OAKLAND",
						date: "2026-09-20",
						merchant_name: "Blue Bottle",
					}),
					// ...and the older one for the 0412 text, where "Blue Bottle Coffee" is newer.
					transaction({
						transaction_id: "old",
						date: "2026-08-02",
						merchant_name: "Blue Bottle",
					}),
					transaction({
						transaction_id: "new",
						date: "2026-09-27",
						merchant_name: "Blue Bottle Coffee",
					}),
				],
			});
			expect(await pendingNames()).toEqual([
				["Blue Bottle"],
				["Blue Bottle Coffee"],
			]);
		});

		it("never touches a name a person chose, or a suggestion they decided", async () => {
			const id = await addItem();
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO merchants (raw_name, display_name) VALUES ('Blue Bottle', 'My coffee')",
				),
				env.DB.prepare(
					"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('Blue Bottle Cafe', 'rejected', 0)",
				),
				env.DB.prepare(
					"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('Blue Bottle Cafe', 0, 'Blue Bottle Cafe')",
				),
			]);
			await sync(id, {
				added: [
					transaction({
						transaction_id: "a",
						date: "2026-07-01",
						merchant_name: "Blue Bottle",
					}),
					transaction({
						transaction_id: "b",
						date: "2026-08-01",
						merchant_name: "Blue Bottle Cafe",
					}),
					transaction({
						transaction_id: "c",
						date: "2026-09-27",
						merchant_name: "Blue Bottle Coffee",
					}),
				],
			});
			expect(await merchants()).toEqual([
				{
					raw_name: "Blue Bottle",
					names: [],
					display_name: "My coffee",
					suggestion_status: "none",
				},
				{
					raw_name: "Blue Bottle Cafe",
					names: ["Blue Bottle Cafe"],
					display_name: null,
					suggestion_status: "rejected",
				},
				{
					raw_name: "Blue Bottle Coffee",
					names: ["Blue Bottle Coffee"],
					display_name: null,
					suggestion_status: "pending",
				},
			]);
		});

		it("is about one bank text only: other texts keep their own names", async () => {
			const id = await addItem();
			await sync(id, {
				added: [
					transaction({
						transaction_id: "a",
						merchant_name: "Blue Bottle Coffee",
					}),
					transaction({
						transaction_id: "b",
						name: "SQ *LUPITAS TAQ 2210",
						merchant_name: "Lupita's Taqueria",
					}),
				],
			});
			expect(await pendingNames()).toEqual([
				["Blue Bottle Coffee"],
				["Lupita's Taqueria"],
			]);
		});
	});

	it("is a bank fact: still suggested with the merchant names switch off", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('ai_names', 'off')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toMatchObject([
			{ names: ["Blue Bottle Coffee"], suggestion_status: "pending" },
		]);
	});

	it("follows a copied row: a name a person gave the bank text carries over and nothing is suggested over it", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES ('SQ *BLUE BOTTLE COF 0412', 'My coffee place')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toMatchObject([
			{
				raw_name: "Blue Bottle Coffee",
				display_name: "My coffee place",
				names: [],
				suggestion_status: "none",
			},
			{ raw_name: "SQ *BLUE BOTTLE COF 0412" },
		]);
	});
});

// Workers AI is the fallback (spec §8.6, decision 68): Plaid's name costs no AI call, and a bank text Plaid
// sent no name for is asked about once, in the nightly names step.
describe("Workers AI is asked only when Plaid sends no name", () => {
	const aiThatSays = (response: string) =>
		fakeAi(vi.fn(async () => ({ response })));

	beforeEach(async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchant_suggested_names"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM household_settings WHERE key = 'ai_names'"),
		]);
	});

	it("makes Plaid's name the suggestion without calling Workers AI", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction()] });
		const ai = aiThatSays("Something Else");
		await suggestMerchantNames({ DB: env.DB, AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
		expect(await merchants()).toEqual([
			{
				raw_name: "Blue Bottle Coffee",
				names: ["Blue Bottle Coffee"],
				display_name: null,
				suggestion_status: "pending",
			},
		]);
	});

	it("asks Workers AI once for a bank text Plaid sent no name for, and not again for a second charge with that text", async () => {
		const id = await addItem();
		await sync(id, {
			added: [transaction({ transaction_id: "first", merchant_name: null })],
		});
		const ai = aiThatSays("Blue Bottle Coffee\nBlue Bottle");
		await suggestMerchantNames({ DB: env.DB, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(1);

		await sync(id, {
			added: [transaction({ transaction_id: "second", merchant_name: null })],
		});
		await suggestMerchantNames({ DB: env.DB, AI: ai });
		expect(ai.run).toHaveBeenCalledTimes(1);
		expect(await merchants()).toEqual([
			{
				raw_name: "SQ *BLUE BOTTLE COF 0412",
				names: ["Blue Bottle Coffee", "Blue Bottle"],
				display_name: null,
				suggestion_status: "pending",
			},
		]);
	});

	it("never renames: a suggestion is not the display name until a person chooses, and a name a person chose is not replaced by a later Plaid name", async () => {
		const id = await addItem();
		await sync(id, { added: [transaction()] });
		expect((await merchants())[0]).toMatchObject({
			display_name: null,
			suggestion_status: "pending",
		});
		await env.DB.prepare(
			"UPDATE merchants SET display_name = 'The Bottle', suggestion_status = 'accepted' WHERE raw_name = 'Blue Bottle Coffee'",
		).run();
		await sync(id, {
			modified: [transaction({ date: "2026-09-28" })],
			added: [transaction({ transaction_id: "later" })],
		});
		expect(await merchants()).toMatchObject([
			{ display_name: "The Bottle", suggestion_status: "accepted" },
		]);
	});

	it("with the names switch off, offers Plaid's name and makes no Workers AI call", async () => {
		const id = await addItem();
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('ai_names', 'off')",
		).run();
		await sync(id, {
			added: [
				transaction(),
				transaction({
					transaction_id: "unnamed",
					name: "SQ *LUPITAS TAQ 2210",
					merchant_name: null,
				}),
			],
		});
		const ai = aiThatSays("Lupita's Taqueria");
		await suggestMerchantNames({ DB: env.DB, AI: ai });
		expect(ai.run).not.toHaveBeenCalled();
		expect(await merchants()).toMatchObject([
			{ names: ["Blue Bottle Coffee"], suggestion_status: "pending" },
		]);
	});
});

async function resetTables() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchant_suggested_names"),
		env.DB.prepare("DELETE FROM merchants"),
		env.DB.prepare("DELETE FROM household_settings WHERE key = 'ai_names'"),
	]);
}

// A page saves its names in a few grouped statements, however many charges it holds: D1 allows 1,000
// queries in one invocation, and each charge already costs about six of them.
describe("a page of named charges stays under D1's query limit", () => {
	beforeEach(resetTables);

	const page = (named: boolean) =>
		Array.from({ length: 100 }, (_, i) =>
			transaction({
				transaction_id: `c${i}`,
				name: `SQ *SHOP${i} 0412`,
				merchant_name: named ? `Shop ${i} Coffee` : null,
			}),
		);

	it("saves 100 new charges, each with its own Plaid name, in under 1,000 statements", async () => {
		const id = await addItem();
		const counted = counting(env.DB);
		await sync(id, { added: page(true), db: counted.db });
		expect(counted.statements()).toBeLessThan(1000 - 50);
		expect(await pendingNames()).toHaveLength(100);
	});

	it("spends the same few statements on names whether a page holds 1 name or 100", async () => {
		const unnamedId = await addItem();
		const unnamed = counting(env.DB);
		await sync(unnamedId, { added: page(false), db: unnamed.db });
		await resetTables();

		const id = await addItem();
		const named = counting(env.DB);
		await sync(id, { added: page(true), db: named.db });
		// Everything Plaid's names add is a handful of statements, none per charge. The bank's names and the newest names
		// are three statements each (a merchant row, then its names), so the page's extra statements are a fixed 16.
		expect(named.statements() - unnamed.statements()).toBeLessThanOrEqual(16);
	});
});

// One bank text's newest remaining charge decides its Plaid name (decision 79), whatever leaves the text:
// a charge the bank removes, or one whose bank text changes.
describe("a bank text's newest charge leaves it", () => {
	const newest = (overrides: JsonObject = {}) =>
		transaction({
			transaction_id: "new",
			date: "2026-09-27",
			merchant_name: "Blue Bottle Coffee",
			...overrides,
		});

	const older = (overrides: JsonObject = {}) =>
		transaction({
			transaction_id: "old",
			date: "2026-08-02",
			merchant_name: "Blue Bottle",
			...overrides,
		});

	beforeEach(resetTables);

	it("offers the remaining charge's name when the bank removes the newest one", async () => {
		const id = await addItem();
		await sync(id, { added: [newest(), older()] });
		expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);

		await sync(id, { removed: ["new"] });
		expect(await pendingNames()).toEqual([["Blue Bottle"]]);
		expect(await merchants()).toContainEqual({
			raw_name: "Blue Bottle",
			names: ["Blue Bottle"],
			display_name: null,
			suggestion_status: "pending",
		});
	});

	it("keeps the newest name when the bank removes an older charge", async () => {
		const id = await addItem();
		await sync(id, { added: [newest(), older()] });
		await sync(id, { removed: ["old"] });
		expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);
	});

	it("offers nothing when the remaining charge's name is only the bank's text tidied", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				newest({ name: "TARGET 1234", merchant_name: "Target Corp" }),
				older({ name: "TARGET 1234", merchant_name: "Target" }),
			],
		});
		expect(await pendingNames()).toEqual([["Target Corp"]]);
		await sync(id, { removed: ["new"] });
		expect(await pendingNames()).toEqual([]);
	});

	it("never touches a name a person chose, or a suggestion they decided", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, display_name) VALUES ('Blue Bottle', 'My coffee')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggestion_status, names_asked) VALUES ('Blue Bottle Cafe', 'rejected', 0)",
			),
			env.DB.prepare(
				"INSERT INTO merchant_suggested_names (merchant_key, position, name) VALUES ('Blue Bottle Cafe', 0, 'Blue Bottle Cafe')",
			),
		]);
		await sync(id, {
			added: [
				newest(),
				older(),
				older({ transaction_id: "mid", merchant_name: "Blue Bottle Cafe" }),
			],
		});
		await sync(id, { removed: ["new"] });
		// The two rows a person settled are exactly as they were.
		expect(
			(await merchants()).filter(
				(row) => row.raw_name !== "Blue Bottle Coffee",
			),
		).toEqual([
			{
				raw_name: "Blue Bottle",
				names: [],
				display_name: "My coffee",
				suggestion_status: "none",
			},
			{
				raw_name: "Blue Bottle Cafe",
				names: ["Blue Bottle Cafe"],
				display_name: null,
				suggestion_status: "rejected",
			},
		]);
	});

	it("waits for the last page to count a pending charge the bank dropped", async () => {
		const id = await addItem();
		await sync(id, { added: [newest({ pending: true }), older()] });
		const seen: string[][][] = [];
		await syncPages(id, [{ removed: ["new"], hasMore: true }, {}], {
			between: async () => {
				seen.push(await pendingNames());
			},
		});
		// Not deleted yet, so its name is still the one offered; once the update ends it is gone.
		expect(seen).toEqual([[["Blue Bottle Coffee"]]]);
		expect(await pendingNames()).toEqual([["Blue Bottle"]]);
	});

	it("offers the older name again when the newest charge's bank text changes", async () => {
		const id = await addItem();
		await sync(id, { added: [newest(), older()] });
		expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);

		await sync(id, { modified: [newest({ name: "BLUE BOTTLE OAKLAND" })] });
		// The Oakland text's newest charge is still "Blue Bottle Coffee"; the old text's is now "Blue Bottle".
		expect(await pendingNames()).toEqual([
			["Blue Bottle"],
			["Blue Bottle Coffee"],
		]);
	});

	it("does not revive an older name a person decided when a bank text changes", async () => {
		const id = await addItem();
		await sync(id, { added: [newest(), older()] });
		await env.DB.prepare(
			"UPDATE merchants SET suggestion_status = 'rejected' WHERE raw_name = 'Blue Bottle'",
		).run();
		await sync(id, { modified: [newest({ name: "BLUE BOTTLE OAKLAND" })] });
		expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);
	});

	it("offers the older name again when a pending charge posts under a different bank text", async () => {
		const id = await addItem();
		await sync(id, { added: [newest({ pending: true }), older()] });
		expect(await pendingNames()).toEqual([["Blue Bottle Coffee"]]);

		// The bank posts it as a new transaction with new text, and drops the pending one.
		await sync(id, {
			added: [
				newest({
					transaction_id: "posted",
					pending_transaction_id: "new",
					name: "BLUE BOTTLE OAKLAND",
				}),
			],
			removed: ["new"],
		});
		expect(await pendingNames()).toEqual([
			["Blue Bottle"],
			["Blue Bottle Coffee"],
		]);
	});

	it("leaves nothing offered when the removed charge was the text's only one", async () => {
		const id = await addItem();
		await sync(id, { added: [newest()] });
		await sync(id, { removed: ["new"] });
		expect(await pendingNames()).toEqual([]);
	});
});

// A bank text Plaid sent no name for is asked about once, and Workers AI's guesses wait on its row (spec §7).
// Once Plaid names that text, Workers AI isn't asked (decision 68), and when Plaid's name is only the text
// (or the text tidied) there is nothing to suggest (decision 79): a guess made earlier is not carried over
// to the Plaid-named merchant to sit there as "Tally's guess".
describe("a guess Workers AI made before Plaid named the text", () => {
	const GUESS = ["Target Stores", "Target Corp"];

	const unnamed = (overrides: JsonObject = {}) =>
		transaction({
			transaction_id: "t1",
			name: "TARGET 1234",
			merchant_name: null,
			...overrides,
		});

	const row = async (key: string) => {
		const found = await env.DB.prepare(
			"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = ?",
		)
			.bind(key)
			.first<{ display_name: string | null; suggestion_status: string }>();

		return found && { ...found, names: await merchantNames(env.DB, key) };
	};

	const guessOn = (key: string) =>
		seedMerchant(env.DB, { key, status: "pending", names: GUESS });

	beforeEach(resetTables);

	it("is not offered for the merchant once Plaid's name is only the bank's text tidied", async () => {
		const id = await addItem();
		await sync(id, { added: [unnamed()] });
		await guessOn("TARGET 1234");
		expect(await pendingNames()).toEqual([]);

		await sync(id, {
			modified: [unnamed({ merchant_name: "Target" })],
		});
		expect(await row("Target")).toEqual({
			names: [],
			display_name: null,
			suggestion_status: "none",
		});
		expect(await pendingNames()).toEqual([]);
	});

	it("is not offered when Plaid's name is the bank's text itself", async () => {
		const id = await addItem();
		await sync(id, {
			added: [unnamed({ name: "Netflix", merchant_name: null })],
		});
		await guessOn("Netflix");
		await sync(id, {
			modified: [unnamed({ name: "Netflix", merchant_name: "Netflix" })],
		});
		expect(await row("Netflix")).toEqual({
			names: [],
			display_name: null,
			suggestion_status: "none",
		});
	});

	it("is not offered for a charge that arrives named, when the text's row holds one", async () => {
		const id = await addItem();
		await guessOn("TARGET 1234");
		await sync(id, { added: [unnamed({ merchant_name: "Target" })] });
		expect(await row("Target")).toEqual({
			names: [],
			display_name: null,
			suggestion_status: "none",
		});
		expect(await pendingNames()).toEqual([]);
	});

	it("never touches a name a person chose, or a suggestion they decided", async () => {
		const id = await addItem();
		await sync(id, { added: [unnamed()] });
		// A guess a person has named: the row is pending with the name they chose, and the guess is kept (the stale
		// clearing only touches a row with no chosen name).
		await seedMerchant(env.DB, {
			key: "TARGET 1234",
			status: "pending",
			names: GUESS,
			displayName: "My Target",
		});
		await sync(id, { modified: [unnamed({ merchant_name: "Target" })] });
		expect(await row("Target")).toEqual({
			names: GUESS,
			display_name: "My Target",
			suggestion_status: "pending",
		});

		await clearMerchants(env.DB);
		await seedMerchant(env.DB, {
			key: "TARGET 1234",
			status: "rejected",
			names: GUESS,
		});
		await sync(id, { modified: [unnamed({ merchant_name: "Target" })] });
		expect(await row("Target")).toEqual({
			names: GUESS,
			display_name: null,
			suggestion_status: "rejected",
		});
	});

	it("stays for the other charges that still have no Plaid name", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				unnamed({ transaction_id: "a", name: "Netflix" }),
				unnamed({ transaction_id: "b", name: "Netflix" }),
			],
		});
		await guessOn("Netflix");
		// One of the two is named after all; the other still reads the same row.
		await sync(id, {
			modified: [
				unnamed({
					transaction_id: "a",
					name: "Netflix",
					merchant_name: "Netflix",
				}),
			],
		});
		expect(await row("Netflix")).toMatchObject({
			suggestion_status: "pending",
		});
	});

	it("leaves the bank's own name alone when another bank text gets Plaid's name that needs none", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				// For this text "Target" is a real suggestion...
				unnamed({
					transaction_id: "a",
					name: "TGT*0099",
					merchant_name: "Target",
				}),
				// ...and for this one it is only the text tidied.
				unnamed({ transaction_id: "b", merchant_name: "Target" }),
			],
		});
		expect(await row("Target")).toEqual({
			names: ["Target"],
			display_name: null,
			suggestion_status: "pending",
		});
	});
});

// The copy of a Plaid name reads its bank texts' rows from before the page writes them (copyPlaidNamesSql). A bank text on
// the page that is also another pair's Plaid name is read as it was. The rows named here have a display name, so the
// newest-name step of the same sync (which only replaces a merchant with no name chosen) leaves the copied names alone.
describe("a bank text that is also another Plaid name on the same page (copy reads before the page writes)", () => {
	beforeEach(resetTables);

	it("copies the names of a text as they were, when that text is also a Plaid name on the page", async () => {
		await seedMerchant(env.DB, {
			key: "COMCAST*1",
			status: "pending",
			names: ["Comcast Cable Co", "Xfinity"],
			displayName: "Comcast Cable",
		});
		await seedMerchant(env.DB, {
			key: "COMCAST*2",
			status: "pending",
			names: ["Other Co"],
		});
		const id = await addItem();
		await sync(id, {
			added: [
				// "Comcast" is the name of a charge whose bank text is COMCAST*1, which is also the Plaid name of another charge.
				transaction({
					transaction_id: "a",
					name: "COMCAST*1",
					merchant_name: "Comcast",
					date: "2026-09-27",
				}),
				transaction({
					transaction_id: "b",
					name: "COMCAST*2",
					merchant_name: "COMCAST*1",
					date: "2026-09-27",
				}),
			],
		});
		expect(await merchantNames(env.DB, "Comcast")).toEqual([
			"Comcast Cable Co",
			"Xfinity",
		]);
		expect(
			await env.DB.prepare(
				"SELECT display_name, suggestion_status FROM merchants WHERE raw_name = 'Comcast'",
			).first(),
		).toEqual({ display_name: "Comcast Cable", suggestion_status: "pending" });
		await assertMerchantInvariants(env.DB);
	});

	// The copy removes a key's names past the count of its text after the same page has written the text. The text's count
	// is never below what the copy read (the page only overwrites positions), and a text that wins for a key that already
	// has names is one the page cannot rewrite, so the count is right here. This test pins the case the order is for:
	// "T1" is copied from "X1" on page one, and on page two it takes "X2"'s single name (accepted, so it ranks first), while
	// "Comcast" copies its three names from "T1" in the same page.
	it("keeps all three names a copied name takes from a text that the same sync rewrites to one name", async () => {
		await seedMerchant(env.DB, {
			key: "X1",
			status: "pending",
			names: ["Q1", "Q2", "Q3"],
			displayName: "Named X1",
		});
		await seedMerchant(env.DB, {
			key: "X2",
			status: "accepted",
			names: ["R1"],
		});
		const id = await addItem();
		await syncPages(id, [
			{
				added: [
					transaction({
						transaction_id: "a",
						name: "X1",
						merchant_name: "T1",
						date: "2026-09-20",
					}),
				],
				hasMore: true,
			},
			{
				added: [
					transaction({
						transaction_id: "b",
						name: "T1",
						merchant_name: "Comcast",
						date: "2026-09-27",
					}),
					transaction({
						transaction_id: "c",
						name: "X2",
						merchant_name: "T1",
						date: "2026-09-27",
					}),
				],
			},
		]);
		expect(await merchantNames(env.DB, "Comcast")).toEqual(["Q1", "Q2", "Q3"]);
		await assertMerchantInvariants(env.DB);
	});
});

// The copy's second statement removes a key's names past the count of its winner text, and reads that count after the
// first statement has rewritten rows. These two cases make the text's count change within the same sync: the text is
// the Plaid name of a pair on page two, which rewrites it. The copy must keep every name it copied.
describe("a copy whose bank text the same sync rewrites to a different number of names (count read after the write)", () => {
	beforeEach(resetTables);

	it("copies three names from a text that the same sync rewrites down to one name, and keeps all three", async () => {
		await seedMerchant(env.DB, {
			key: "BANK ZERO",
			status: "pending",
			names: ["A1", "A2", "A3"],
			displayName: "Named Zero",
		});
		await seedMerchant(env.DB, {
			key: "BANK ONE",
			status: "accepted",
			names: ["B1"],
		});
		const id = await addItem();
		await syncPages(id, [
			{
				added: [
					transaction({
						transaction_id: "a",
						name: "BANK ZERO",
						merchant_name: "Shared Name",
						date: "2026-09-20",
					}),
				],
				hasMore: true,
			},
			{
				added: [
					// "Key Copy" copies its names from "Shared Name", as it stood before this page.
					transaction({
						transaction_id: "b",
						name: "Shared Name",
						merchant_name: "Key Copy",
						date: "2026-09-27",
					}),
					// "Shared Name" is rewritten on this page, to the accepted name of "BANK ONE".
					transaction({
						transaction_id: "c",
						name: "BANK ONE",
						merchant_name: "Shared Name",
						date: "2026-09-27",
					}),
				],
			},
		]);
		expect(await merchantNames(env.DB, "Shared Name")).toEqual(["B1"]);
		expect(await merchantNames(env.DB, "Key Copy")).toEqual(["A1", "A2", "A3"]);
		await assertMerchantInvariants(env.DB);
	});

	it("copies one name from a text that the same sync rewrites up to three names, and keeps just the one", async () => {
		await seedMerchant(env.DB, {
			key: "BANK ZERO",
			status: "pending",
			names: ["A1"],
			displayName: "Named Zero",
		});
		await seedMerchant(env.DB, {
			key: "BANK ONE",
			status: "accepted",
			names: ["B1", "B2", "B3"],
		});
		const id = await addItem();
		await syncPages(id, [
			{
				added: [
					transaction({
						transaction_id: "a",
						name: "BANK ZERO",
						merchant_name: "Shared Name",
						date: "2026-09-20",
					}),
				],
				hasMore: true,
			},
			{
				added: [
					transaction({
						transaction_id: "b",
						name: "Shared Name",
						merchant_name: "Key Copy",
						date: "2026-09-27",
					}),
					transaction({
						transaction_id: "c",
						name: "BANK ONE",
						merchant_name: "Shared Name",
						date: "2026-09-27",
					}),
				],
			},
		]);
		expect(await merchantNames(env.DB, "Shared Name")).toEqual([
			"B1",
			"B2",
			"B3",
		]);
		expect(await merchantNames(env.DB, "Key Copy")).toEqual(["A1"]);
		await assertMerchantInvariants(env.DB);
	});
});

// A none-asked text (rank 2) beats a named pending destination (rank 4), so the copy can take a winner that has no names.
// Before the copy removed a none winner's destination names itself, only the unscoped sweep (which runs later in the same
// batch) removed them, and this test failed with the sweep disabled. It now passes either way: the copy is self-sufficient.
describe("a copy whose winner has no names, over a destination that had names", () => {
	beforeEach(resetTables);

	it("leaves the destination with no names and the status the winner gives, when a named pending key is beaten by an asked text", async () => {
		await seedMerchant(env.DB, { key: "Y", status: "none", namesAsked: true });
		await seedMerchant(env.DB, {
			key: "V",
			status: "pending",
			names: ["D1", "D2"],
			displayName: "Named K",
		});
		await seedMerchant(env.DB, {
			key: "U",
			status: "accepted",
			names: ["U1", "U2", "U3"],
		});
		const id = await addItem();
		await syncPages(
			id,
			[
				{
					added: [
						// Page one: K copies V (pending, named), and T copies Y (asked, no names).
						transaction({
							transaction_id: "a",
							name: "V",
							merchant_name: "K",
							date: "2026-09-20",
						}),
						transaction({
							transaction_id: "b",
							name: "Y",
							merchant_name: "T",
							date: "2026-09-20",
						}),
					],
					hasMore: true,
				},
				{
					added: [
						// Page two: K copies T (asked, no names, so it beats K's own pending row), and T takes U (accepted).
						transaction({
							transaction_id: "c",
							name: "T",
							merchant_name: "K",
							date: "2026-09-27",
						}),
						transaction({
							transaction_id: "d",
							name: "U",
							merchant_name: "T",
							date: "2026-09-27",
						}),
					],
				},
			],
			{
				// Between the pages T is an asked text with no names, the state the copy on page two starts from.
				between: async () => {
					await seedMerchant(env.DB, {
						key: "T",
						status: "none",
						namesAsked: true,
					});
				},
			},
		);

		const statusOf = async (key: string) =>
			env.DB.prepare(
				"SELECT suggestion_status AS status, names_asked AS asked, display_name AS display FROM merchants WHERE raw_name = ?",
			)
				.bind(key)
				.first();

		expect(await statusOf("K")).toEqual({
			status: "none",
			asked: 1,
			display: "Named K",
		});
		expect(await merchantNames(env.DB, "K")).toEqual([]);
		expect(await statusOf("T")).toEqual({
			status: "accepted",
			asked: 0,
			display: null,
		});
		expect(await merchantNames(env.DB, "T")).toEqual(["U1", "U2", "U3"]);
		expect(await statusOf("U")).toEqual({
			status: "accepted",
			asked: 0,
			display: null,
		});
		expect(await merchantNames(env.DB, "U")).toEqual(["U1", "U2", "U3"]);
		await assertMerchantInvariants(env.DB);
	});
});
