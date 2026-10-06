import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { transactions } from "../src/routes/transactions";

// The first visit's empty Transactions list (spec §8.5, decisions 54, 55 and 72): "nothing at all"
// means no transaction in any month, so the family app says "Link a bank" or "Importing" instead of
// "No transactions match".

const family = { ...env, DEMO: "false" } as unknown as Env;
const demo = { ...env, DEMO: "true" } as unknown as Env;

// A signed-in family member, as the Access middleware sets one, so writes have an actor.
const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
app.use("*", async (c, next) => {
	c.set("actor", "family@example.com");
	await next();
});
app.route("/", transactions);

async function get(path: string, bindings: Env = family) {
	const res = await app.request(path, {}, bindings);
	return { res, html: await res.text() };
}

async function post(path: string, body: Record<string, string>) {
	const res = await app.request(
		path,
		{
			method: "POST",
			headers: {
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(body),
		},
		family,
	);
	return { res, html: await res.text() };
}

const NO_BANK = "Link a bank to see transactions.";
const NO_BANK_HINT = "Tally can only read them; it can&#39;t move money.";
const IMPORTING = "Importing your transactions…";
const IMPORTING_HINT =
	"Your bank sends about 90 days of them. It usually takes a few minutes.";
const NO_MATCH = "No transactions match these filters.";

// EmptyState's accent marks: the add sign's circle, and the magnifier's.
const ADD_SIGN = '<circle cx="45" cy="44" r="10"';
const MAGNIFIER = '<circle cx="44" cy="42" r="9"';

/** No transactions anywhere, and no bank. */
async function emptyHousehold() {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	await env.DB.batch([
		env.DB.prepare("DELETE FROM bill_payments"),
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM balance_history"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
	]);
}

const linkBank = (disconnected = false) =>
	env.DB.prepare(
		`INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, disconnected_at)
		 VALUES (X'', 'First Bank', 'family@example.com', ${disconnected ? "datetime('now')" : "NULL"})`,
	).run();

// Controls that wait for the first transaction (P40 A).
const waiting = (html: string) => {
	expect(html).not.toContain('id="q"');
	expect(html).not.toContain('id="filters"');
	expect(html).not.toContain('id="select-toggle"');
	expect(html).not.toContain('id="result-count"');
	expect(html).not.toContain("Needs category");
	expect(html).not.toContain(NO_MATCH);
};

beforeEach(emptyHousehold);

describe("the first visit, no bank linked", () => {
	it("says Link a bank, with a secondary link to Accounts and the add sign", async () => {
		const { res, html } = await get("/transactions");
		expect(res.status).toBe(200);
		expect(html).toContain(NO_BANK);
		expect(html).toContain(NO_BANK_HINT);
		expect(html).toMatch(
			/<a[^>]*href="\/accounts"[^>]*border-ink[^>]*>Link a bank<\/a>/,
		);
		expect(html).toContain(ADD_SIGN);
		expect(html).not.toContain(MAGNIFIER);
		expect(html).not.toContain(IMPORTING);
		waiting(html);
	});

	it("keeps the title and Add cash, since cash works without a bank", async () => {
		const { html } = await get("/transactions");
		expect(html).toMatch(/<h1[^>]*>Transactions<\/h1>/);
		expect(html).toMatch(
			/<a[^>]*href="\/transactions\/cash\/new\?back=[^"]+"[^>]*id="add-cash"/,
		);
	});

	it("is the same for a bank that was disconnected", async () => {
		await linkBank(true);
		const { html } = await get("/transactions");
		expect(html).toContain(NO_BANK);
		expect(html).not.toContain(IMPORTING);
	});

	it("is still the first visit when the address carries a filter, since there is nothing to filter", async () => {
		for (const path of [
			"/transactions?q=zzz",
			"/transactions?month=2020-01",
			"/transactions?uncategorized=1",
		]) {
			const { html } = await get(path);
			expect(html).toContain(NO_BANK);
			waiting(html);
			expect(html).not.toContain("Every transaction has a category.");
		}
	});

	it("ignores select mode, with no selection form or action bar", async () => {
		const { html } = await get("/transactions?select=1");
		expect(html).toContain(NO_BANK);
		expect(html).not.toContain('id="selection-form"');
		expect(html).not.toContain('id="selected-count"');
	});

	it("keeps the Add cash sheet usable over the first visit", async () => {
		const { res, html } = await get("/transactions/cash/new");
		expect(res.status).toBe(200);
		expect(html).toContain("Add cash spending");
		expect(html).toContain('<div id="sheet">');
		expect(html).toContain(NO_BANK);
	});
});

describe("the first visit, a bank linked and nothing arrived yet", () => {
	it("says Importing, with the magnifier and no button", async () => {
		await linkBank();
		const { res, html } = await get("/transactions");
		expect(res.status).toBe(200);
		expect(html).toContain(IMPORTING);
		expect(html).toContain(IMPORTING_HINT);
		expect(html).toContain(MAGNIFIER);
		expect(html).not.toContain(ADD_SIGN);
		expect(html).not.toContain(NO_BANK);
		// The only way to Accounts is the sidebar and tabs, not a button in the empty list.
		const results = html.slice(html.indexOf('aria-label="Results"'));
		expect(results.slice(0, results.indexOf('<div id="sheet">'))).not.toContain(
			"<a",
		);
		waiting(html);
	});

	it("counts a bank that needs attention as linked", async () => {
		await linkBank();
		await env.DB.prepare(
			"UPDATE plaid_items SET status='needs_attention'",
		).run();
		expect((await get("/transactions")).html).toContain(IMPORTING);
	});

	it("keeps Add cash", async () => {
		await linkBank();
		expect((await get("/transactions")).html).toContain('id="add-cash"');
	});
});

describe("once there is any transaction, in any month", () => {
	async function oneOldTransaction() {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'checking')",
			),
			env.DB.prepare(
				"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id) VALUES (1, '2020-01-15', 1250, 'OLD CAFE', 1)",
			),
		]);
	}

	it("keeps today's no results for a month with nothing in it, with no bank", async () => {
		await oneOldTransaction();
		const { html } = await get("/transactions");
		expect(html).toContain(NO_MATCH);
		expect(html).toMatch(
			/<a[^>]*href="\/transactions"[^>]*>Clear filters<\/a>/,
		);
		expect(html).not.toContain(NO_BANK);
		expect(html).not.toContain(IMPORTING);
		expect(html).toContain('id="q"');
		expect(html).toContain('id="select-toggle"');
		expect(html).toContain('id="result-count"');
	});

	it("keeps today's no results with a bank linked too", async () => {
		await oneOldTransaction();
		await linkBank();
		const { html } = await get("/transactions");
		expect(html).toContain(NO_MATCH);
		expect(html).not.toContain(IMPORTING);
	});

	it("keeps today's no results for a search that matches nothing", async () => {
		await oneOldTransaction();
		for (const path of [
			"/transactions?month=all&q=zzz",
			"/transactions?month=all&category=2",
		]) {
			const { html } = await get(path);
			expect(html).toContain(NO_MATCH);
			expect(html).not.toContain(NO_BANK);
			expect(html).not.toContain(IMPORTING);
		}
	});

	it("keeps the done message when every transaction has a category", async () => {
		await oneOldTransaction();
		const { html } = await get("/transactions?month=all&uncategorized=1");
		expect(html).toContain("Every transaction has a category.");
	});

	it("lists the transaction when it matches", async () => {
		await oneOldTransaction();
		const { html } = await get("/transactions?month=all");
		expect(html).toContain("Old cafe");
		expect(html).not.toContain(NO_BANK);
	});
});

describe("the demo", () => {
	it("keeps today's no results over its seeded transactions", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		for (const path of ["/transactions?q=zzz", "/transactions?month=2020-01"]) {
			const { html } = await get(path, demo);
			expect(html).toContain(NO_MATCH);
			expect(html).not.toContain(NO_BANK);
			expect(html).not.toContain(IMPORTING);
		}
	});

	it("never offers Link a bank, even if its list were empty", async () => {
		for (const path of ["/transactions", "/transactions?q=zzz"]) {
			const { html } = await get(path, demo);
			expect(html).toContain(NO_MATCH);
			expect(html).not.toContain(NO_BANK);
			expect(html).not.toContain(IMPORTING);
			expect(html).toContain('id="q"');
		}
	});
});

describe("the empty-list check", () => {
	/** Every statement the page runs, recorded. */
	function recorded() {
		const sql: string[] = [];
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare")
					return (statement: string) => {
						sql.push(statement);
						return target.prepare(statement);
					};
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return { sql, bindings: { ...family, DB: db } as unknown as Env };
	}

	it("runs only when the list is empty", async () => {
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const full = recorded();
		await get("/transactions", full.bindings);
		// The Account choice reads plaid_items too (to mark a disconnected bank), so this finds the
		// first-visit statement by its answer.
		const firstVisitCheck = (s: string) => s.includes("'importing'");
		expect(full.sql.some(firstVisitCheck)).toBe(false);

		await emptyHousehold();
		const empty = recorded();
		await get("/transactions", empty.bindings);
		expect(empty.sql.filter(firstVisitCheck)).toHaveLength(1);
	});
});

describe("the page after the first cash entry", () => {
	const cash = {
		date: todayIn(DEFAULT_TIME_ZONE),
		amount: "12.50",
		merchant: "Farmers market",
		category: "1",
		note: "",
		back: "/transactions",
	};

	it("swaps all of main, so the search, filters and Select arrive with the first row", async () => {
		const { res, html } = await post("/transactions/cash", cash);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Retarget")).toBe("#main");
		expect(res.headers.get("HX-Reswap")).toBe("innerHTML");
		expect(res.headers.get("HX-Reselect")).toBe("#main > *");
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toMatchObject({
			toast: { message: "Added Farmers market", type: "success" },
		});
		expect(html).toContain("Farmers market");
		expect(html).toContain('id="filters"');
		expect(html).toContain('id="select-toggle"');
		expect(html).not.toContain(NO_BANK);
		// Focus goes to the title, since the control that was pressed is swapped away.
		expect(html).toMatch(/<h1[^>]*id="transactions-title"[^>]*autofocus/);
	});

	it("swaps only #page once there are other transactions", async () => {
		await post("/transactions/cash", cash);
		const { res } = await post("/transactions/cash", cash);
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Retarget")).toBeNull();
		expect(res.headers.get("HX-Reswap")).toBeNull();
		expect(res.headers.get("HX-Reselect")).toBeNull();
	});

	it("stays on #page when the first entry has an error, since the page is still the first visit", async () => {
		const { res, html } = await post("/transactions/cash", {
			...cash,
			merchant: "",
		});
		expect(res.status).toBe(422);
		expect(res.headers.get("HX-Retarget")).toBeNull();
		expect(html).toContain("Enter where you spent it.");
		expect(html).toContain(NO_BANK);
	});

	it("brings the first visit back, whole, when the last transaction is deleted", async () => {
		await post("/transactions/cash", cash);
		const id = (
			await env.DB.prepare("SELECT id FROM transactions").first<{
				id: number;
			}>()
		)?.id;
		const { res, html } = await post(`/transactions/${id}/delete`, {
			back: "/transactions",
			confirm: "1",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Retarget")).toBe("#main");
		expect(res.headers.get("HX-Reswap")).toBe("innerHTML");
		expect(res.headers.get("HX-Reselect")).toBe("#main > *");
		expect(html).toContain(NO_BANK);
		waiting(html);
	});

	it("deleting one of several leaves the swap on #page", async () => {
		await post("/transactions/cash", cash);
		await post("/transactions/cash", cash);
		const id = (
			await env.DB.prepare("SELECT id FROM transactions").first<{
				id: number;
			}>()
		)?.id;
		const { res, html } = await post(`/transactions/${id}/delete`, {
			back: "/transactions",
			confirm: "1",
		});
		expect(res.headers.get("HX-Retarget")).toBeNull();
		expect(html).toContain("Farmers market");
	});
});
