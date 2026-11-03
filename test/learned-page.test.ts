import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset";

// Settings' "What Tally has learned" page (decisions 156 and 162): one bordered line per learned text, Forget with
// the usual toast and a ten-second Undo, and an empty state. The Forget posts the cleaned text in its body only.

const db = env.DB;
const BASE = "http://tally.test";
const INTRO =
	"Tally files these the way you chose them. Forget one and Tally goes back to guessing.";

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: Record<string, string>, htmx = true) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: {
			message: string;
			type?: string;
			undo?: string;
			undoExpiresInMs?: number;
			undoAction?: string;
		};
		announce?: string;
	};

const textOf = (html: string) =>
	html
		.replace(/<[^>]+>/g, "")
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");

/** Every URL the page draws in an attribute: links, forms and HTMX targets. */
const urlsIn = (html: string) =>
	[...html.matchAll(/\s(?:href|action|hx-[a-z-]+)="([^"]*)"/g)].map(
		(m) => m[1],
	);

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

async function answer(
	raw: string,
	category: string,
	source = "user",
	date = "2026-10-02",
) {
	await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, 1499, ?, ?, ?)`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			date,
			raw,
			await categoryId(category),
			source,
		)
		.run();
}

beforeEach(async () => {
	await resetDemo(db, "2026-10-15");
	// The demo has no Entertainment category; the default list does, and these tests file rows under it.
	await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Entertainment', 'entertainment', 'entertainment', 'cat-blue', 90)",
		),
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Books & audio', 'books & audio', 'books', 'cat-plum', 95)",
		),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM forgotten_texts"),
		db.prepare("DELETE FROM bank_text_rules"),
	]);
});

describe("GET /settings/learned: the page", () => {
	it("has one h1, Settings as its first link, the intro sentence, and a bordered line with Forget", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const { res, html } = await get("/settings/learned");
		expect(res.status).toBe(200);
		expect(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]).toBe(
			"What Tally has learned",
		);
		const back = html.indexOf('<a href="/settings" class="flex min-h-11');
		expect(back).toBeGreaterThan(-1);
		expect(back).toBeLessThan(html.indexOf("<h1"));
		expect(textOf(html)).toContain(INTRO);
		expect(html).toContain('<li class="flex min-h-16');
		expect(html).toContain("border border-rule");
		expect(textOf(html)).toContain("Netflix.com → Entertainment");
		expect(textOf(html)).toContain("From 1 of your answers");
		expect(html).toContain('action="/settings/learned/forget"');
	});

	it("names its section by the heading id toast.js hands focus to when an Undo toast ends", async () => {
		// toast.js's focusHeading falls back to #page-title on a page with no Transactions heading (bills' page is the
		// same), so keyboard focus lands on this page's heading rather than on the body.
		const { html } = await get("/settings/learned");
		expect(html).toMatch(
			/<h1 id="page-title"[^>]*>What Tally has learned<\/h1>/,
		);
		expect(html).toContain('aria-labelledby="page-title"');
	});

	it("names each Forget button with its line, for a screen reader", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const { html } = await get("/settings/learned");
		expect(html).toContain(
			'<span class="sr-only"> Netflix.com → Entertainment</span>',
		);
	});

	it("offers Change in place on a line: a labelled select, the sentence, and Save with a Cancel link", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const { html } = await get("/settings/learned");
		expect(html).toContain("<details");
		expect(html).toContain("Change<span");
		expect(html).toContain('<label for="page-category-0"');
		expect(html).toContain('<select id="page-category-0" name="category"');
		expect(textOf(html)).toContain(
			"From now on Netflix.com goes here every time.",
		);
		expect(html).toContain('action="/settings/learned/change"');
		expect(html).toContain('hx-post="/settings/learned/change"');
		expect(textOf(html)).toContain("Save");
		expect(textOf(html)).toContain("Cancel");
		// The select starts on the line's category.
		expect(html).toMatch(/<option[^>]* selected[^>]*>Entertainment<\/option>/);
		expect(html).not.toMatch(
			/<option[^>]* selected[^>]*>Books &amp; audio<\/option>/,
		);
	});

	it("gives a known-vague text no Change, only Forget", async () => {
		await answer("APPLE.COM/BILL 09/30", "Entertainment");
		const { html } = await get("/settings/learned");
		expect(html).not.toContain("<details");
		expect(textOf(html)).not.toMatch(/\bChange\b/);
		expect(html).toContain('action="/settings/learned/forget"');
	});

	it("shows the empty state when nothing is learned", async () => {
		const { res, html } = await get("/settings/learned");
		expect(res.status).toBe(200);
		expect(textOf(html)).toContain("Nothing yet");
		expect(textOf(html)).toContain(
			"Answer a few Maybes and what you choose shows up here.",
		);
		expect(html).not.toContain('<li class="flex min-h-16');
	});

	it("never shows a line from Jev's own guess", async () => {
		await answer("TRADER JOES 0412", "Groceries", "jev");
		const { html } = await get("/settings/learned");
		expect(textOf(html)).toContain("Nothing yet");
	});

	it("shows a known-vague text as a line with its Forget", async () => {
		await answer("APPLE.COM/BILL 09/30", "Entertainment");
		const { html } = await get("/settings/learned");
		expect(textOf(html)).toContain("Apple.com/bill → Entertainment");
		expect(html).toContain('action="/settings/learned/forget"');
	});
});

describe("GET /settings: the contents row", () => {
	it("lists the page beside Tally's rules, with its live count", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await answer("SPOTIFY USA", "Entertainment");
		const { html } = await get("/settings");
		expect(html).toContain('href="/settings/learned"');
		expect(textOf(html)).toContain("2 lines");
		const rules = html.indexOf('href="/settings/rules"');
		const learned = html.indexOf('href="/settings/learned"');
		const household = html.indexOf('href="/settings/household"');
		expect(rules).toBeLessThan(learned);
		expect(learned).toBeLessThan(household);
	});

	it("says Nothing yet when there are no lines", async () => {
		const { html } = await get("/settings");
		const row =
			html.split('href="/settings/learned"')[1]?.split("</a>")[0] ?? "";
		expect(textOf(row)).toContain("Nothing yet");
	});
});

describe("POST /settings/learned/forget", () => {
	it("hides the line, keeps it hidden on a later render, and offers a ten-second Undo", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const { res, html } = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		expect(res.status).toBe(200);
		const t = trigger(res);
		expect(t.toast?.message).toBe(
			"Forgot Netflix.com → Entertainment. Tally goes back to guessing.",
		);
		expect(t.toast?.undoExpiresInMs).toBeGreaterThanOrEqual(9000);
		expect(t.toast?.undoExpiresInMs).toBeLessThanOrEqual(10000);
		expect(t.toast?.undoAction).toBe("/settings/learned/undo");
		expect(t.toast?.undo).toMatch(/^\d+$/);
		expect(t.announce).toBe(t.toast?.message);
		expect(textOf(html)).toContain("Nothing yet");
		const again = await get("/settings/learned");
		expect(textOf(again.html)).toContain("Nothing yet");
	});

	it("posts the cleaned text in the body, never in an address", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const { html } = await get("/settings/learned");
		expect(urlsIn(html).join(" ")).not.toMatch(/netflix/i);
		const { res } = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		expect(res.headers.get("location")).toBeNull();
	});

	it("is undone by Undo within the window, and the line comes back", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const forgot = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		const token = trigger(forgot.res).toast?.undo ?? "";
		const undo = await post("/settings/learned/undo", {
			token,
			back: "/settings/learned",
		});
		expect(trigger(undo.res).toast?.message).toBe(
			"Forget undone. Tally has that line back.",
		);
		expect(trigger(undo.res).toast).toMatchObject({ type: "success" });
		expect(textOf(undo.html)).toContain("Netflix.com → Entertainment");
	});

	it("is not undone after the ten seconds, and the line stays forgotten", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		// The answer was made before the Forget, so it stays forgotten once the Forget is moved back.
		await db
			.prepare(
				"UPDATE transactions SET updated_at = datetime('now', '-1 minute')",
			)
			.run();
		const forgot = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		const token = trigger(forgot.res).toast?.undo ?? "";
		await db
			.prepare(
				"UPDATE forgotten_texts SET forgotten_at = datetime('now', '-30 seconds') WHERE id = ?",
			)
			.bind(Number(token))
			.run();
		const undo = await post("/settings/learned/undo", {
			token,
			back: "/settings/learned",
		});
		expect(trigger(undo.res).toast).toMatchObject({
			type: "error",
			message: "Undo expired. The line stays forgotten.",
		});
		expect(textOf(undo.html)).toContain("Nothing yet");
	});

	it("brings the line back from an answer made after the Forget", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await post("/settings/learned/forget", { text: "netflix.com" });
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, updated_at = datetime('now', '+1 minute') WHERE raw_name = 'NETFLIX.COM'",
			)
			.bind(await categoryId("Groceries"))
			.run();
		const { html } = await get("/settings/learned");
		expect(textOf(html)).toContain("Netflix.com → Groceries");
	});

	it("Undo of a second Forget restores the state before it, and no older answer comes back", async () => {
		// An old answer, made before the first Forget, that the first Forget hides.
		await answer("NETFLIX.COM", "Entertainment", "user", "2026-10-02");
		await db
			.prepare("UPDATE transactions SET updated_at = '2026-10-02 12:00:00'")
			.run();
		const first = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		expect(textOf((await get("/settings/learned")).html)).toContain(
			"Nothing yet",
		);
		// Pin the first Forget's time so the answers' times are unambiguous.
		await db
			.prepare(
				"UPDATE forgotten_texts SET forgotten_at = '2026-10-10 09:00:00'",
			)
			.run();
		expect(trigger(first.res).toast?.undo).toBeDefined();
		// A newer answer after the first Forget brings the line back.
		await answer("NETFLIX.COM", "Groceries", "user", "2026-10-11");
		await db
			.prepare(
				"UPDATE transactions SET updated_at = '2026-10-11 09:00:00' WHERE category_id = ?",
			)
			.bind(await categoryId("Groceries"))
			.run();
		expect(textOf((await get("/settings/learned")).html)).toContain(
			"Netflix.com → Groceries",
		);
		// The second Forget hides it again; its Undo must put back the state just before it.
		const second = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		expect(textOf((await get("/settings/learned")).html)).toContain(
			"Nothing yet",
		);
		const undo = await post("/settings/learned/undo", {
			token: trigger(second.res).toast?.undo ?? "",
			back: "/settings/learned",
		});
		expect(trigger(undo.res).toast?.message).toBe(
			"Forget undone. Tally has that line back.",
		);
		const after = textOf(undo.html);
		expect(after).toContain("Netflix.com → Groceries");
		expect(after).toContain("From 1 of your answers");
		// The Change form lists every category, so only the line itself says what it files under.
		expect(after).not.toContain("Netflix.com → Entertainment");
		const row = await db
			.prepare(
				"SELECT forgotten_at AS f, previous_forgotten_at AS p FROM forgotten_texts",
			)
			.first<{ f: string; p: string | null }>();
		expect(row).toEqual({ f: "2026-10-10 09:00:00", p: null });
	});

	it("is a quiet no-op for a line that is already gone, with no forgotten row written", async () => {
		const { res } = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		expect(trigger(res).toast?.message).toBe(
			"Forgot Netflix.com. Tally goes back to guessing.",
		);
		expect(trigger(res).toast?.undo).toBeUndefined();
		const rows = await db
			.prepare("SELECT COUNT(*) AS n FROM forgotten_texts")
			.first<{ n: number }>();
		expect(rows?.n).toBe(0);
	});

	it("refuses a Forget with no text, with an error the page announces", async () => {
		const { res, html } = await post("/settings/learned/forget", {});
		expect(res.status).toBe(400);
		expect(textOf(html)).toContain("Choose a line to forget.");
		expect(trigger(res).announce).toBe("Choose a line to forget.");
	});

	it("works without script: a plain form post goes back to the page", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const { res } = await post(
			"/settings/learned/forget",
			{ text: "netflix.com" },
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings/learned");
	});
});

const ruleOf = async (text: string) =>
	(
		await db
			.prepare(
				"SELECT category_id AS categoryId FROM bank_text_rules WHERE cleaned_text = ?",
			)
			.bind(text)
			.first<{ categoryId: number }>()
	)?.categoryId ?? null;

describe("POST /settings/learned/change", () => {
	it("makes the rule, applies it at once, and says so in a toast and an announcement", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await answer("NETFLIX.COM", "Entertainment", "user", "2026-10-03");
		const books = await categoryId("Books & audio");
		const { res, html } = await post("/settings/learned/change", {
			text: "netflix.com",
			category: String(books),
		});
		expect(res.status).toBe(200);
		expect(trigger(res).toast).toMatchObject({
			message: "Netflix.com now goes to Books & audio every time.",
			type: "success",
		});
		expect(trigger(res).announce).toBe(trigger(res).toast?.message);
		expect(await ruleOf("netflix.com")).toBe(books);
		expect(textOf(html)).toContain("Netflix.com → Books & audio");
		expect(textOf(html)).toContain("Your rule");
	});

	it("leaves a row the person sorted by hand as it is", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await post("/settings/learned/change", {
			text: "netflix.com",
			category: String(await categoryId("Books & audio")),
		});
		const row = await db
			.prepare(
				"SELECT category_id AS c, category_source AS s FROM transactions",
			)
			.first<{ c: number; s: string }>();
		expect(row).toEqual({ c: await categoryId("Entertainment"), s: "user" });
	});

	it("saves twice into one row, with the latest category", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await post("/settings/learned/change", {
			text: "netflix.com",
			category: String(await categoryId("Books & audio")),
		});
		await post("/settings/learned/change", {
			text: "netflix.com",
			category: String(await categoryId("Entertainment")),
		});
		const n = await db
			.prepare("SELECT COUNT(*) AS n FROM bank_text_rules")
			.first<{ n: number }>();
		expect(n?.n).toBe(1);
		expect(await ruleOf("netflix.com")).toBe(await categoryId("Entertainment"));
	});

	it("refuses a known-vague text with an alert, and makes no rule", async () => {
		await answer("APPLE.COM/BILL 09/30", "Entertainment");
		const { res, html } = await post("/settings/learned/change", {
			text: "apple.com/bill",
			category: String(await categoryId("Books & audio")),
		});
		expect(res.status).toBe(400);
		expect(html).toContain('role="alert"');
		expect(trigger(res).announce).toBeDefined();
		expect(await ruleOf("apple.com/bill")).toBeNull();
	});

	it("refuses an unknown or archived category beside its own line, with an alert", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const unknown = await post("/settings/learned/change", {
			text: "netflix.com",
			category: "999999",
		});
		expect(unknown.res.status).toBe(400);
		expect(unknown.html).toContain('role="alert"');
		expect(unknown.html).toContain("Choose a category.");
		// The disclosure opens with its error, so the error is on screen.
		expect(unknown.html).toMatch(/<details[^>]* open/);
		await db
			.prepare(
				"UPDATE categories SET archived = 1 WHERE name = 'Books & audio'",
			)
			.run();
		const archived = await post("/settings/learned/change", {
			text: "netflix.com",
			category: String(await categoryId("Books & audio")),
		});
		expect(archived.res.status).toBe(400);
		expect(await ruleOf("netflix.com")).toBeNull();
	});

	it("refuses a text with no line on the page, with the page's alert", async () => {
		const { res, html } = await post("/settings/learned/change", {
			text: "",
			category: String(await categoryId("Books & audio")),
		});
		expect(res.status).toBe(400);
		expect(html).toContain('role="alert"');
	});

	it("works without script: a plain form post goes back to the page", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const { res } = await post(
			"/settings/learned/change",
			{
				text: "netflix.com",
				category: String(await categoryId("Books & audio")),
			},
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings/learned");
	});
});

describe("the learned page with a rule", () => {
	it("shows the rule's category and 'Your rule' in place of the answers' count", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await db
			.prepare(
				"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES ('netflix.com', ?)",
			)
			.bind(await categoryId("Books & audio"))
			.run();
		const { html } = await get("/settings/learned");
		expect(textOf(html)).toContain("Netflix.com → Books & audio");
		expect(textOf(html)).toContain("Your rule");
		expect(textOf(html)).not.toContain("From 1 of your answers");
	});

	it("gives a rule with no answers a line, and Settings' count includes it", async () => {
		await db
			.prepare(
				"INSERT INTO bank_text_rules (cleaned_text, category_id) VALUES ('netflix.com', ?)",
			)
			.bind(await categoryId("Books & audio"))
			.run();
		const { html } = await get("/settings/learned");
		expect(textOf(html)).toContain("Netflix.com → Books & audio");
		expect(textOf(html)).toContain("Your rule");
		const settings = await get("/settings");
		expect(textOf(settings.html)).toContain("1 line");
	});

	it("Forget on a rule's line removes the rule, and its Undo puts the rule and the line back", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const books = await categoryId("Books & audio");
		await post("/settings/learned/change", {
			text: "netflix.com",
			category: String(books),
		});
		const forgot = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		expect(textOf(forgot.html)).toContain("Nothing yet");
		expect(await ruleOf("netflix.com")).toBeNull();
		const undo = await post("/settings/learned/undo", {
			token: trigger(forgot.res).toast?.undo ?? "",
			back: "/settings/learned",
		});
		expect(trigger(undo.res).toast?.message).toBe(
			"Forget undone. Tally has that line back.",
		);
		expect(textOf(undo.html)).toContain("Netflix.com → Books & audio");
		expect(await ruleOf("netflix.com")).toBe(books);
	});

	it("names a rule's line in the Forget toast as the line now reads", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await post("/settings/learned/change", {
			text: "netflix.com",
			category: String(await categoryId("Books & audio")),
		});
		const { res } = await post("/settings/learned/forget", {
			text: "netflix.com",
		});
		expect(trigger(res).toast?.message).toBe(
			"Forgot Netflix.com → Books & audio. Tally goes back to guessing.",
		);
	});
});
