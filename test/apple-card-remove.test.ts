import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { accounts } from "../src/routes/accounts";
import { recordSorting } from "./record-sorting";

recordSorting({ sort: true });

// Remove Apple Card (spec §8.10, #766): kept by default, deleted with its transactions when asked. Modelled on Disconnect.
const TODAY = todayIn(DEFAULT_TIME_ZONE);
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
		'09/10/2026,09/11/2026,"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40"',
		'09/12/2026,09/13/2026,"THAI PALACE 4 OAK ST SPRINGFIELD 00000 XX USA","Thai Palace","Restaurants","Purchase","24.10"',
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

	it("is not found before there is a card to remove", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE subtype = 'apple_card')",
			),
			env.DB.prepare("DELETE FROM accounts WHERE subtype = 'apple_card'"),
		]);
		expect(
			(await app.request("/accounts/apple-card/remove", {}, family)).status,
		).toBe(404);
		expect(
			(await post("/accounts/apple-card/remove", "", family)).res.status,
		).toBe(404);
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
});
