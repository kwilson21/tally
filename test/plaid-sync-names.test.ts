import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { namesToReview } from "../src/db/merchant-names";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { suggestMerchantNames } from "../src/suggest-names-pending";

// Plaid's merchant name is the merchant's first suggested name (spec §8.6, decision 68, issue #194):
// sync stores it, with no AI call, and a person still has to choose it.

const KEY = btoa("01234567890123456789012345678901");

const transaction = (overrides: Record<string, unknown> = {}) => ({
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
	modified?: unknown[];
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
			const value = Reflect.get(target, property);
			if (property === "prepare") {
				return (sql: string) => {
					statements += 1;
					return target.prepare(sql);
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { db: counted as D1Database, statements: () => statements };
}

type MerchantRow = {
	raw_name: string;
	suggested_name: string | null;
	display_name: string | null;
	suggestion_status: string;
};

/** The suggested names waiting for a person, in order, for merchants that still have a charge (the review lists no other). */
const pendingNames = async () =>
	(
		await env.DB.prepare(
			`SELECT suggested_name FROM merchants
			 WHERE suggestion_status = 'pending'
			   AND EXISTS (SELECT 1 FROM transactions t WHERE t.merchant_name = merchants.raw_name)
			 ORDER BY raw_name`,
		).all<{ suggested_name: string }>()
	).results.map((row) => row.suggested_name);

const merchants = async () =>
	(
		await env.DB.prepare(
			"SELECT raw_name, suggested_name, display_name, suggestion_status FROM merchants ORDER BY raw_name",
		).all<MerchantRow>()
	).results;

describe("Plaid's merchant name as the first name suggestion", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
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
				suggested_name: "Blue Bottle Coffee",
				display_name: null,
				suggestion_status: "pending",
			},
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
		expect((await merchants()).map((m) => m.suggested_name)).toEqual([
			"T-Mobile",
		]);
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
				suggested_name: null,
				display_name: "The Bottle",
				suggestion_status: "none",
			},
		]);
	});

	it("does not suggest again to someone who already decided (accepted or rejected)", async () => {
		const id = await addItem();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Blue Bottle Coffee', 'Blue Bottle Coffee', 'rejected')",
			),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Lupitas', 'Lupitas', 'accepted')",
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
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Blue Bottle Coffee', 'Blue Bottle', 'pending')",
		).run();
		await sync(id, { added: [transaction()] });
		expect(await merchants()).toMatchObject([
			{
				suggested_name: "Blue Bottle Coffee",
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
		const row = await env.DB.prepare(
			`SELECT m.suggested_name FROM transactions t
			 JOIN merchants m ON m.raw_name = COALESCE(NULLIF(t.merchant_name, ''), t.raw_name)`,
		).first<{ suggested_name: string }>();
		expect(row?.suggested_name).toBe("Blue Bottle");
		// The name no charge carries any more is not asked about.
		expect(await pendingNames()).toEqual(["Blue Bottle"]);
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

			expect(await pendingNames()).toEqual(["Target", "Target Corp"]);
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
			expect(await pendingNames()).toEqual(["Blue Bottle"]);
			await sync(id, {
				added: [
					transaction({
						transaction_id: "new",
						date: "2026-09-27",
						merchant_name: "Blue Bottle Coffee",
					}),
				],
			});
			expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);
			// The older name's merchant is untouched apart from its waiting suggestion.
			expect(await merchants()).toEqual([
				{
					raw_name: "Blue Bottle",
					suggested_name: null,
					display_name: null,
					suggestion_status: "none",
				},
				{
					raw_name: "Blue Bottle Coffee",
					suggested_name: "Blue Bottle Coffee",
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
			expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);
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
			expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);
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
			expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);
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
			expect(await pendingNames()).toEqual(["Target Corp"]);
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
					suggested_name: "Target Corp",
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
				"Blue Bottle",
				"Blue Bottle Coffee",
			]);
		});

		it("never touches a name a person chose, or a suggestion they decided", async () => {
			const id = await addItem();
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO merchants (raw_name, display_name) VALUES ('Blue Bottle', 'My coffee')",
				),
				env.DB.prepare(
					"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Blue Bottle Cafe', 'Blue Bottle Cafe', 'rejected')",
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
					suggested_name: null,
					display_name: "My coffee",
					suggestion_status: "none",
				},
				{
					raw_name: "Blue Bottle Cafe",
					suggested_name: "Blue Bottle Cafe",
					display_name: null,
					suggestion_status: "rejected",
				},
				{
					raw_name: "Blue Bottle Coffee",
					suggested_name: "Blue Bottle Coffee",
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
				"Blue Bottle Coffee",
				"Lupita's Taqueria",
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
			{ suggested_name: "Blue Bottle Coffee", suggestion_status: "pending" },
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
				suggested_name: null,
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
		({ run: vi.fn(async () => ({ response })) }) as unknown as Ai & {
			run: ReturnType<typeof vi.fn>;
		};

	beforeEach(async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
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
				suggested_name: "Blue Bottle Coffee",
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
				suggested_name: "Blue Bottle Coffee\nBlue Bottle",
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
			{ suggested_name: "Blue Bottle Coffee", suggestion_status: "pending" },
		]);
	});
});

async function resetTables() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
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
		// Everything Plaid's names add is a handful of statements, none per charge.
		expect(named.statements() - unnamed.statements()).toBeLessThanOrEqual(8);
	});
});

// One bank text's newest remaining charge decides its Plaid name (decision 79), whatever leaves the text:
// a charge the bank removes, or one whose bank text changes.
describe("a bank text's newest charge leaves it", () => {
	const newest = (overrides: Record<string, unknown> = {}) =>
		transaction({
			transaction_id: "new",
			date: "2026-09-27",
			merchant_name: "Blue Bottle Coffee",
			...overrides,
		});
	const older = (overrides: Record<string, unknown> = {}) =>
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
		expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);

		await sync(id, { removed: ["new"] });
		expect(await pendingNames()).toEqual(["Blue Bottle"]);
		expect(await merchants()).toContainEqual({
			raw_name: "Blue Bottle",
			suggested_name: "Blue Bottle",
			display_name: null,
			suggestion_status: "pending",
		});
	});

	it("keeps the newest name when the bank removes an older charge", async () => {
		const id = await addItem();
		await sync(id, { added: [newest(), older()] });
		await sync(id, { removed: ["old"] });
		expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);
	});

	it("offers nothing when the remaining charge's name is only the bank's text tidied", async () => {
		const id = await addItem();
		await sync(id, {
			added: [
				newest({ name: "TARGET 1234", merchant_name: "Target Corp" }),
				older({ name: "TARGET 1234", merchant_name: "Target" }),
			],
		});
		expect(await pendingNames()).toEqual(["Target Corp"]);
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
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('Blue Bottle Cafe', 'Blue Bottle Cafe', 'rejected')",
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
				suggested_name: null,
				display_name: "My coffee",
				suggestion_status: "none",
			},
			{
				raw_name: "Blue Bottle Cafe",
				suggested_name: "Blue Bottle Cafe",
				display_name: null,
				suggestion_status: "rejected",
			},
		]);
	});

	it("waits for the last page to count a pending charge the bank dropped", async () => {
		const id = await addItem();
		await sync(id, { added: [newest({ pending: true }), older()] });
		const seen: string[][] = [];
		await syncPages(id, [{ removed: ["new"], hasMore: true }, {}], {
			between: async () => {
				seen.push(await pendingNames());
			},
		});
		// Not deleted yet, so its name is still the one offered; once the update ends it is gone.
		expect(seen).toEqual([["Blue Bottle Coffee"]]);
		expect(await pendingNames()).toEqual(["Blue Bottle"]);
	});

	it("offers the older name again when the newest charge's bank text changes", async () => {
		const id = await addItem();
		await sync(id, { added: [newest(), older()] });
		expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);

		await sync(id, { modified: [newest({ name: "BLUE BOTTLE OAKLAND" })] });
		// The Oakland text's newest charge is still "Blue Bottle Coffee"; the old text's is now "Blue Bottle".
		expect(await pendingNames()).toEqual(["Blue Bottle", "Blue Bottle Coffee"]);
	});

	it("does not revive an older name a person decided when a bank text changes", async () => {
		const id = await addItem();
		await sync(id, { added: [newest(), older()] });
		await env.DB.prepare(
			"UPDATE merchants SET suggestion_status = 'rejected' WHERE raw_name = 'Blue Bottle'",
		).run();
		await sync(id, { modified: [newest({ name: "BLUE BOTTLE OAKLAND" })] });
		expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);
	});

	it("offers the older name again when a pending charge posts under a different bank text", async () => {
		const id = await addItem();
		await sync(id, { added: [newest({ pending: true }), older()] });
		expect(await pendingNames()).toEqual(["Blue Bottle Coffee"]);

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
		expect(await pendingNames()).toEqual(["Blue Bottle", "Blue Bottle Coffee"]);
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
	const GUESS = "Target Stores\nTarget Corp";
	const unnamed = (overrides: Record<string, unknown> = {}) =>
		transaction({
			transaction_id: "t1",
			name: "TARGET 1234",
			merchant_name: null,
			...overrides,
		});
	const row = (key: string) =>
		env.DB.prepare(
			"SELECT suggested_name, display_name, suggestion_status FROM merchants WHERE raw_name = ?",
		)
			.bind(key)
			.first();
	const guessOn = (key: string, status = "pending") =>
		env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES (?, ?, ?)",
		)
			.bind(key, GUESS, status)
			.run();

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
			suggested_name: null,
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
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
	});

	it("is not offered for a charge that arrives named, when the text's row holds one", async () => {
		const id = await addItem();
		await guessOn("TARGET 1234");
		await sync(id, { added: [unnamed({ merchant_name: "Target" })] });
		expect(await row("Target")).toEqual({
			suggested_name: null,
			display_name: null,
			suggestion_status: "none",
		});
		expect(await pendingNames()).toEqual([]);
	});

	it("never touches a name a person chose, or a suggestion they decided", async () => {
		const id = await addItem();
		await sync(id, { added: [unnamed()] });
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, suggested_name, display_name, suggestion_status) VALUES ('TARGET 1234', ?, 'My Target', 'none')",
		)
			.bind(GUESS)
			.run();
		await sync(id, { modified: [unnamed({ merchant_name: "Target" })] });
		expect(await row("Target")).toEqual({
			suggested_name: GUESS,
			display_name: "My Target",
			suggestion_status: "none",
		});

		await env.DB.batch([
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('TARGET 1234', ?, 'rejected')",
			).bind(GUESS),
		]);
		await sync(id, { modified: [unnamed({ merchant_name: "Target" })] });
		expect(await row("Target")).toEqual({
			suggested_name: GUESS,
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
			suggested_name: "Target",
			display_name: null,
			suggestion_status: "pending",
		});
	});
});
