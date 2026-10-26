import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, daysBefore, todayIn } from "../src/dates";
import { readFirstTally } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { firstPage } from "../src/routes/first-page";
import { home } from "../src/routes/home";
import { plaid } from "../src/routes/plaid";
import { setupRoute } from "../src/routes/setup";

// The first week from the top (P125 E, spec §8.8, decision 114), through the routes the family app mounts together: a
// new family links a bank on Home, the questions open once the import is in, Home's Band opens the question page, and
// the page's first answer draws the pay stroke. Plaid is mocked as plaid-routes.test.ts mocks it; the verified identity
// is set as first-page-route.test.ts sets it.

const db = env.DB;
const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
/** plaid-routes.test.ts's token key: 32 bytes of seven, base64. */
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** The family app's bindings, with Plaid on (as plaid-routes.test.ts sets them) and the test's own database. */
const bindings = {
	...env,
	DB: db,
	DEMO: "false",
	PLAID_CLIENT_ID: "client-id",
	PLAID_SECRET: "plaid-secret",
	PLAID_ENV: "sandbox",
	PLAID_WEBHOOK_URL: "https://tally.test/webhooks/plaid",
	TOKEN_ENCRYPTION_KEY: KEY,
} as unknown as Env;

const router = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
router.use("*", async (c, next) => {
	c.set("actor", "person@example.com");
	await next();
});
router.route("/", home);
router.route("/", setupRoute);
router.route("/", plaid);
router.route("/", firstPage);

const family = {
	fetch(
		path: string,
		init?: RequestInit,
		waitUntil: (promise: Promise<unknown>) => void = () => {},
	) {
		return router.fetch(new Request(BASE + path, init), bindings, {
			waitUntil,
			passThroughOnException() {},
			props: {},
		});
	},
};

/** A page's HTML with its apostrophes as the browser reads them (home-setup-route.test.ts unescapes them the same way). */
async function words(res: Response) {
	return (await res.text()).replaceAll("&#39;", "'");
}

/** The hidden fields a form submits under one name, unescaped as the browser sends them (as first-page-route.test.ts). */
function hiddenFields(html: string, name: string): [string, string][] {
	return [
		...html.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, "g")),
	].map(([, value]): [string, string] => [
		name,
		(value ?? "")
			.replaceAll("&#39;", "'")
			.replaceAll("&quot;", '"')
			.replaceAll("&amp;", "&"),
	]);
}

/** One imported bank line on the family's one connected bank (account 1), written as first-page-route.test.ts writes them. */
async function deposit(raw: string, cents: number) {
	const category = await db
		.prepare("SELECT id FROM categories WHERE archived = 0 ORDER BY id LIMIT 1")
		.first<{ id: number }>();
	await db
		.prepare(
			`INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name, category_id, category_source, category_confidence, income_confidence, flag_income, plaid_category)
			VALUES (1, 'first-week-1', ?1, ?2, ?3, ?4, 'user', 90, 0, 1, 'INCOME')`,
		)
		.bind(TODAY, -cents, raw, category?.id ?? 1)
		.run();
}

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await db.prepare("DELETE FROM transactions").run();
	await db.prepare("DELETE FROM bill_payments").run();
	await db.prepare("DELETE FROM bills").run();
	await db.prepare("DELETE FROM merchants").run();
	await db.prepare("DELETE FROM accounts").run();
	await db.prepare("DELETE FROM plaid_items").run();
	// A new family has no budgets yet, so the budgets step has categories to ask (#590).
	await db.prepare("DELETE FROM budget_amounts").run();
	await db
		.prepare("DELETE FROM household_settings WHERE key = 'first_tally'")
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the first week, from Home to the pay stroke", () => {
	it("a new household links a bank, the gate opens, setup moves on to /first-page, and its answer draws the pay stroke", async () => {
		// A fresh household: setup's welcome offers the one button and no strokes are drawn (Home sends a family here, decision 148).
		const fresh = await words(await family.fetch("/setup"));
		expect(fresh).toContain("Welcome to Tally.");
		expect(fresh).toContain("Link your bank");

		// Linking draws stroke one on the household's day, in the exchange's own batch. The first sync it starts gets
		// Plaid's not-ready page, so the gate below is opened by hand.
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/item/public_token/exchange"))
				return Response.json({
					access_token: "access-private",
					item_id: "item-1",
				});
			if (url.endsWith("/item/get"))
				return Response.json({ item: { institution_id: "ins-1" } });
			if (url.endsWith("/institutions/get_by_id"))
				return Response.json({ institution: { name: "Chase" } });
			if (url.endsWith("/accounts/get")) return Response.json({ accounts: [] });
			if (url.endsWith("/transactions/sync"))
				return Response.json({
					added: [],
					modified: [],
					removed: [],
					next_cursor: "",
					has_more: false,
					transactions_update_status: "NOT_READY",
				});
			throw new Error(`unrouted Plaid call ${url}`);
		});
		const promises: Promise<unknown>[] = [];
		const exchange = await family.fetch(
			"/plaid/exchange",
			{
				method: "POST",
				headers: {
					Origin: BASE,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					public_token: "public-private",
				}).toString(),
			},
			(promise) => promises.push(promise),
		);
		expect(exchange.status).toBe(204);
		await Promise.all(promises);
		expect(
			Object.keys(
				JSON.parse(exchange.headers.get("HX-Trigger") ?? "{}"),
			).sort(),
		).toEqual(["announce", "toast"]);
		expect((await readFirstTally(db))?.strokes.bank).toBe(TODAY);

		// Open the gate as first-page-route.test.ts's beforeEach does: the import is in, stroke one is two days old (so
		// the questions open today), and the one pay deposit is there for the question to ask about.
		await db
			.prepare(
				"UPDATE plaid_items SET last_synced_at = ?1, history_complete_at = ?1 WHERE plaid_item_id = 'item-1'",
			)
			.bind(TODAY)
			.run();
		await db
			.prepare(
				"INSERT INTO accounts (id, plaid_item_id, plaid_account_id, name, type) SELECT 1, id, 'acc-1', 'Checking', 'depository' FROM plaid_items WHERE plaid_item_id = 'item-1'",
			)
			.run();
		await db
			.prepare(
				"UPDATE household_settings SET value = json_set(value, '$.strokes.bank', ?1) WHERE key = 'first_tally'",
			)
			.bind(daysBefore(TODAY, 2))
			.run();
		await deposit("ACME CORP PAYROLL", 245000);

		// Setup moves on to the question page once the questions are open (until #773 they are /first-page).
		const moved = await family.fetch("/setup");
		expect(moved.status).toBe(303);
		expect(moved.headers.get("location")).toBe("/first-page");

		// The question page asks the pay question.
		const page = await family.fetch("/first-page");
		expect(page.status).toBe(200);
		const pageHtml = await page.text();
		expect(pageHtml).toContain("Your first page");
		expect(pageHtml).toContain("Is this your pay?");

		// Yes, posted as the page's own form posts it (its merchant and deposit fields, then the answer).
		const answer = await family.fetch("/first-page/pay", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
			},
			body: new URLSearchParams([
				...hiddenFields(pageHtml, "merchant"),
				...hiddenFields(pageHtml, "deposit"),
				["answer", "yes"],
			]).toString(),
		});
		expect(answer.status).toBe(200);
		expect(
			Object.keys(JSON.parse(answer.headers.get("HX-Trigger") ?? "{}")).sort(),
		).toEqual(["announce", "toast"]);
		expect((await readFirstTally(db))?.strokes.pay).not.toBeUndefined();

		// The questions page counts the strokes drawn. The bills step had nothing to ask (no repeat charge), so it counts as done and draws
		// with the pay answer, as the spec says one answer can draw two; the budgets step still has categories to ask.
		expect((await readFirstTally(db))?.strokes.bills).not.toBeUndefined();
		const counted = await words(await family.fetch("/first-page"));
		expect(counted).toContain("3 of 5");
	});
});
