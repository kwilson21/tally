import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, daysBefore, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { accounts } from "../src/routes/accounts";
import { recordSorting } from "./record-sorting";

recordSorting({ sort: true });

// Remove Apple Card (spec §8.10, #766): kept by default, deleted with its transactions when asked. Modelled on Disconnect.
const TODAY = todayIn(DEFAULT_TIME_ZONE);
/** Apple's MM/DD/YYYY for a YYYY-MM-DD day. The rows are dated from the real today, never a fixed date. */
const apple = (day: string) =>
	`${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
const family = { ...env, DEMO: "false" } as unknown as Env;
const demo = { ...env, DEMO: "true" } as unknown as Env;
const PLAID_LINK_SCRIPT =
	"https://cdn.plaid.com/link/v2/stable/link-initialize.js";
const plaidBindings = {
	...family,
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as unknown as Env;
const noPlaid = {
	...family,
	PLAID_CLIENT_ID: undefined,
	PLAID_SECRET: undefined,
} as unknown as Env;

const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
app.use("*", async (c, next) => {
	c.set("actor", "family@example.com");
	await next();
});
app.route("/", accounts);

const ctx = () => ({
	waitUntil: vi.fn<(promise: Promise<unknown>) => void>(() => {}),
	passThroughOnException() {},
	props: {},
});

/** A card with two rows and a balance, made by the upload's own route, as a person would make it. */
async function uploadCard() {
	const csv = [
		"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)",
		`${apple(daysBefore(TODAY, 11))},${apple(daysBefore(TODAY, 10))},"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40"`,
		`${apple(daysBefore(TODAY, 9))},${apple(daysBefore(TODAY, 8))},"THAI PALACE 4 OAK ST SPRINGFIELD 00000 XX USA","Thai Palace","Restaurants","Purchase","24.10"`,
	].join("\n");
	const form = new FormData();
	form.set("file", new File([csv], "apple.csv", { type: "text/csv" }));
	form.set("balance", "1,240.18");
	const request = new Request("http://tally.test/accounts/apple-card", {
		method: "POST",
		body: form,
	});
	const type = request.headers.get("content-type") ?? "";
	const bytes = await request.arrayBuffer();
	const res = await app.request(
		"/accounts/apple-card",
		{
			method: "POST",
			headers: {
				"content-type": type,
				"content-length": String(bytes.byteLength),
				"HX-Request": "true",
			},
			body: bytes,
		},
		family,
		ctx(),
	);
	expect(res.status).toBe(200);
}

const cardCount = () =>
	env.DB.prepare(
		"SELECT COUNT(*) AS n FROM accounts WHERE subtype = 'apple_card'",
	).first<{ n: number }>();
const cardRowCount = () =>
	env.DB.prepare(
		"SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card'",
	).first<{ n: number }>();
const cardHistoryCount = () =>
	env.DB.prepare(
		"SELECT COUNT(*) AS n FROM balance_history h JOIN accounts a ON a.id = h.account_id WHERE a.subtype = 'apple_card'",
	).first<{ n: number }>();

async function post(
	path: string,
	body: string,
	bindings: Env = family,
	htmx = true,
) {
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
	};
	if (htmx) headers["HX-Request"] = "true";
	const res = await app.request(
		path,
		{ method: "POST", headers, body },
		bindings,
		ctx(),
	);
	return { res, html: (await res.text()).replaceAll("&#39;", "'") };
}

/** A database whose batch first runs `before`, as another tab does between this request's read and its batch. */
function racedDb(before: string): D1Database {
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "batch")
				return async (statements: D1PreparedStatement[]) => {
					await target.prepare(before).run();
					return target.batch(statements);
				};
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

// Another tab's keep, and its delete: the writes this request's batch can meet after its own read (spec §8.10).
const OTHER_TAB_KEEPS =
	"UPDATE accounts SET removed_at = datetime('now'), balance_on = NULL WHERE subtype = 'apple_card' AND removed_at IS NULL";
const OTHER_TAB_DELETES = [
	"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE subtype = 'apple_card')",
	"DELETE FROM balance_history WHERE account_id IN (SELECT id FROM accounts WHERE subtype = 'apple_card')",
	"DELETE FROM accounts WHERE subtype = 'apple_card'",
];

describe("Remove Apple Card (#766)", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await resetDemo(env.DB, TODAY);
		await uploadCard();
	});

	it("asks, in the Disconnect page's words, with the card's transactions counted", async () => {
		const res = await app.request("/accounts/apple-card/remove", {}, family);
		const html = (await res.text()).replaceAll("&#39;", "'");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Remove Apple Card? · Tally</title>");
		expect(html).toContain("Remove Apple Card?");
		expect(html).toContain(
			"Its 2 transactions stay, so past months still add up, unless you tick the box below.",
		);
		expect(html).toContain("Also delete its transactions");
		expect(html).toContain("This deletes them for good.");
		expect(html).toContain(">Remove<");
		expect(html).toContain("Cancel");
	});

	it("says its one transaction stays, in the singular, with its verb to match", async () => {
		// Drop the card's newer row, so one is left: the page's count and its verb must agree.
		await env.DB.prepare(
			"DELETE FROM transactions WHERE id IN (SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card' ORDER BY t.id DESC LIMIT 1)",
		).run();
		const html = (
			await (
				await app.request("/accounts/apple-card/remove", {}, family)
			).text()
		).replaceAll("&#39;", "'");
		expect(html).toContain(
			"Its 1 transaction stays, so past months still add up, unless you tick the box below.",
		);
		expect(html).not.toContain("transaction stay,");
	});

	it("keeps the rows and clears the balance by default: the card leaves net worth and Add Apple Card shows again", async () => {
		const { res } = await post("/accounts/apple-card/remove", "");
		expect(res.headers.get("HX-Trigger")).toContain("Removed Apple Card.");
		expect(res.headers.get("HX-Push-Url")).toBe("/accounts");
		expect(await cardRowCount()).toEqual({ n: 2 });
		const card = await env.DB.prepare(
			"SELECT balance_on, removed_at FROM accounts WHERE subtype = 'apple_card'",
		).first<{ balance_on: string | null; removed_at: string | null }>();
		expect(card?.balance_on).toBeNull();
		expect(card?.removed_at).not.toBeNull();
		const html = (
			await (await app.request("/accounts", {}, family)).text()
		).replaceAll("&#39;", "'");
		expect(html).toContain("Removed");
		expect(html).toContain("Add Apple Card");
		expect(html).not.toContain("Remove Apple Card</a>");
	});

	it("deletes its transactions, its balances and the account with delete=yes, and says so", async () => {
		const { res } = await post("/accounts/apple-card/remove", "delete=yes");
		expect(res.headers.get("HX-Trigger")).toContain(
			"Removed Apple Card and deleted its transactions.",
		);
		expect(await cardCount()).toEqual({ n: 0 });
		expect(await cardRowCount()).toEqual({ n: 0 });
		expect(await cardHistoryCount()).toEqual({ n: 0 });
	});

	it("takes the card's copies out of the pay record when its transactions are deleted, and no others", async () => {
		const card = await env.DB.prepare(
			"SELECT t.id AS id FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card' ORDER BY t.id LIMIT 1",
		).first<{ id: number }>();
		const record = {
			pay: {
				"NORTHWIND PAYROLL": {
					at: "2026-10-01",
					yes: { [String(card?.id)]: true },
				},
				"KEEP ME": { at: "2026-10-01", yes: { "999999": true } },
			},
		};
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
			.bind(JSON.stringify(record))
			.run();
		await post("/accounts/apple-card/remove", "delete=yes");
		const after = await env.DB.prepare(
			"SELECT value FROM household_settings WHERE key = 'first_tally'",
		).first<{ value: string }>();
		expect(Object.keys(JSON.parse(after?.value ?? "{}").pay ?? {})).toEqual([
			"KEEP ME",
		]);
	});

	it("says it's already removed when it was removed in another tab, and changes nothing", async () => {
		await post("/accounts/apple-card/remove", "");
		const { res } = await post("/accounts/apple-card/remove", "delete=yes");
		expect(res.headers.get("HX-Trigger")).toContain(
			"Apple Card is already removed.",
		);
		expect(await cardRowCount()).toEqual({ n: 2 });
	});

	it("says it's already removed when another tab keeps the card between this request's read and its batch, and changes nothing", async () => {
		const history = await cardHistoryCount();
		const { res } = await post("/accounts/apple-card/remove", "", {
			...family,
			DB: racedDb(OTHER_TAB_KEEPS),
		} as unknown as Env);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Apple Card is already removed.",
		);
		expect(await cardRowCount()).toEqual({ n: 2 });
		expect(await cardHistoryCount()).toEqual(history);
		// The other tab's change stands: the card is removed and its balance cleared, and nothing here changed it.
		const card = await env.DB.prepare(
			"SELECT balance_on, removed_at FROM accounts WHERE subtype = 'apple_card'",
		).first<{ balance_on: string | null; removed_at: string | null }>();
		expect(card?.balance_on).toBeNull();
		expect(card?.removed_at).not.toBeNull();
	});

	it("says it's already removed when another tab keeps the card while this request deletes it, and deletes nothing", async () => {
		const history = await cardHistoryCount();
		const { res } = await post("/accounts/apple-card/remove", "delete=yes", {
			...family,
			DB: racedDb(OTHER_TAB_KEEPS),
		} as unknown as Env);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Apple Card is already removed.",
		);
		expect(await cardRowCount()).toEqual({ n: 2 });
		expect(await cardHistoryCount()).toEqual(history);
		expect(await cardCount()).toEqual({ n: 1 });
	});

	it("says it's already removed when another tab deletes the card while this request deletes it, and not not-found", async () => {
		// Each of the other tab's statements runs before this request's batch, as a sequence of its own.
		const deleted = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "batch")
					return async (statements: D1PreparedStatement[]) => {
						for (const sql of OTHER_TAB_DELETES)
							await target.prepare(sql).run();
						return target.batch(statements);
					};
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { res } = await post("/accounts/apple-card/remove", "delete=yes", {
			...family,
			DB: deleted,
		} as unknown as Env);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Apple Card is already removed.",
		);
		expect(await cardCount()).toEqual({ n: 0 });
	});

	it("is not found before there is a card to remove, and a remove with none says it's already removed", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE subtype = 'apple_card')",
			),
			env.DB.prepare("DELETE FROM accounts WHERE subtype = 'apple_card'"),
		]);
		expect(
			(await app.request("/accounts/apple-card/remove", {}, family)).status,
		).toBe(404);
		const { res } = await post("/accounts/apple-card/remove", "", family);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Apple Card is already removed.",
		);
	});

	it("says it's already removed when the card was deleted in another tab, not not-found", async () => {
		await post("/accounts/apple-card/remove", "delete=yes");
		const { res } = await post("/accounts/apple-card/remove", "delete=yes");
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain(
			"Apple Card is already removed.",
		);
	});

	it("answers a remove with no card without htmx as Disconnect does: back to Accounts", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE subtype = 'apple_card')",
			),
			env.DB.prepare("DELETE FROM accounts WHERE subtype = 'apple_card'"),
		]);
		const res = await app.request(
			"/accounts/apple-card/remove",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "",
			},
			family,
			ctx(),
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/accounts");
	});

	it("is not found in the demo, where the group has no Manage", async () => {
		expect(
			(await app.request("/accounts/apple-card/remove", {}, demo)).status,
		).toBe(404);
		expect(
			(await post("/accounts/apple-card/remove", "", demo)).res.status,
		).toBe(404);
	});

	it("works without Plaid: the remove isn't gated on Plaid's enabled()", async () => {
		const res = await app.request("/accounts/apple-card/remove", {}, {
			...family,
			PLAID_CLIENT_ID: undefined,
			PLAID_SECRET: undefined,
		} as unknown as Env);
		expect(res.status).toBe(200);
	});

	// The remove form swaps Accounts into the page, so Link a bank on this page needs Plaid Link's scripts, as Disconnect's page has.
	it("loads Plaid Link's scripts when Plaid is configured, and none when it isn't", async () => {
		const withPlaid = await app.request(
			"/accounts/apple-card/remove",
			{},
			plaidBindings,
		);
		expect(withPlaid.status).toBe(200);
		const html = await withPlaid.text();
		expect(html).toContain(`src="${PLAID_LINK_SCRIPT}"`);
		expect(html).toContain('src="/js/plaid-link.js"');

		const withoutPlaid = await app.request(
			"/accounts/apple-card/remove",
			{},
			noPlaid,
		);
		const plain = await withoutPlaid.text();
		expect(plain).not.toContain(PLAID_LINK_SCRIPT);
		expect(plain).not.toContain("/js/plaid-link.js");
	});

	it("keeps Plaid Link's scripts on the page it answers with when the remove fails", async () => {
		// Only the batch fails, so the page re-renders with its error, as it does when D1 is down.
		const failingDb = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "batch")
					return () => Promise.reject(new Error("D1 is down"));
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { res, html } = await post("/accounts/apple-card/remove", "", {
			...plaidBindings,
			DB: failingDb,
		} as unknown as Env);
		expect(res.status).toBe(502);
		expect(html).toContain("Couldn't remove Apple Card. Try again.");
		expect(html).toContain(`src="${PLAID_LINK_SCRIPT}"`);
		expect(html).toContain('src="/js/plaid-link.js"');
	});

	it("answers the 502 Remove page, with the box as it was, when the batch fails and every D1 call after it fails too", async () => {
		// Once the batch has failed, every later D1 call fails as well (a D1 that is down). The page's count was read
		// before the batch, so the failure page needs no read after it and still answers, rather than a bare 500.
		let down = false;
		const downAfterBatch = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "batch")
					return async () => {
						down = true;
						throw new Error("D1 is down");
					};
				if (prop === "prepare")
					return (sql: string) => {
						if (down) throw new Error("D1 is down");
						return target.prepare(sql);
					};
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const historyBefore = await cardHistoryCount();
		const { res, html } = await post(
			"/accounts/apple-card/remove",
			"delete=yes",
			{ ...family, DB: downAfterBatch } as unknown as Env,
		);
		expect(res.status).toBe(502);
		expect(html).toContain("<title>Remove Apple Card? · Tally</title>");
		expect(html).toMatch(
			/role="alert"[^>]*>Couldn't remove Apple Card\. Try again\.</,
		);
		expect(html).toContain(
			"Its 2 transactions stay, so past months still add up, unless you tick the box below.",
		);
		// The box is as the person left it: ticked.
		expect(html).toMatch(/<input[^>]*name="delete"[^>]*\schecked/);
		// Nothing changed: the card is still kept, with the rows and history it had before the request.
		expect(await cardCount()).toEqual({ n: 1 });
		expect(await cardRowCount()).toEqual({ n: 2 });
		const kept = await env.DB.prepare(
			"SELECT removed_at FROM accounts WHERE subtype = 'apple_card'",
		).first<{ removed_at: string | null }>();
		expect(kept?.removed_at).toBeNull();
		expect(await cardHistoryCount()).toEqual(historyBefore);
	});
});
