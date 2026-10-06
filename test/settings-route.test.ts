import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, monthName, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
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
		toast?: { message: string };
		announce?: string;
	};
/** The page's text, without markup. */
const textOf = (html: string) =>
	html.replace(/<[^>]+>/g, "").replaceAll("&#39;", "'");
const THIS_MONTH = () => monthName(todayIn(DEFAULT_TIME_ZONE).slice(0, 7));
/** The names in the Categories list, in order. */
const rowNames = (html: string) =>
	[
		...html.matchAll(
			/<summary[^>]*data-category="\d+"[^>]*>[\s\S]*?<span class="[^"]*font-medium[^"]*">([^<]+)<\/span>/g,
		),
	].map((m) => m[1]);

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("GET /settings", () => {
	it("lists the categories with this month's budget, each opening in place to rename", async () => {
		const { res, html } = await get("/settings");
		expect(res.status).toBe(200);
		expect(html).toMatch(/<h1[^>]*>Settings<\/h1>/);
		expect(html).toMatch(/<section id="categories"/);
		expect(rowNames(html)).toEqual([
			"Groceries",
			"Eating Out",
			"Gas",
			"Kids",
			"Household",
		]);
		expect(textOf(html)).toContain("$700 a month");
		// Budgets are changed on Home (decision 38); each row links there.
		expect(html).not.toContain(`Budget from ${THIS_MONTH()} on`);
		expect(html).not.toContain('name="budget"');
		expect(html).toMatch(
			/<a href="\/budget\/1"[^>]*>Change its budget on Home<\/a>/,
		);
		expect(html).toContain("Add category");
		// Nothing is archived yet, so there's no Archived section.
		expect(html).not.toContain("Archived (");
		// Every row starts closed.
		expect(html).not.toMatch(/<details[^>]*data-row[^>]*\bopen/);
	});

	it("lists merchant rules under one Tally's rules heading in A to Z order", async () => {
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = NULL",
		).run();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('RULE Z', 'Zed', 1), ('RULE A', 'Acme', 2)",
		).run();
		const { html } = await get("/settings");
		const rules = html.slice(html.indexOf('id="merchant-rules"'));
		expect((html.match(/Tally&#39;s rules/g) ?? []).length).toBe(1);
		expect(rules.indexOf("Acme")).toBeLessThan(rules.indexOf("Zed"));
		expect(rules).toContain("Always for these merchants");
		expect(rules).toContain(
			"What Tally does on its own, and what it won&#39;t suggest.",
		);
	});

	it("shows an empty state for an empty merchant rule list", async () => {
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = NULL",
		).run();
		const { html } = await get("/settings");
		expect(html).toContain("No merchants have an Always rule yet.");
	});

	it("shows paused rules and a transaction count, with search only above 20 merchants", async () => {
		await env.DB.prepare(
			"UPDATE merchants SET default_category_id = NULL",
		).run();
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 1",
		).run();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('RULE Costco', 'Costco', 1)",
		).run();
		const twenty = Array.from(
			{ length: 19 },
			(_, i) =>
				`('RULE ${String(i).padStart(2, "0")}', 'Merchant ${String(i).padStart(2, "0")}', 2)`,
		).join(",");
		await env.DB.prepare(
			`INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ${twenty}`,
		).run();
		const exactlyTwenty = await get("/settings");
		expect(exactlyTwenty.html).not.toContain('name="search"');
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES ('RULE 20', 'Cobalt', 2)",
		).run();
		const twentyOne = await get("/settings");
		expect(twentyOne.html).toContain('name="rules_search"');
		expect(twentyOne.html).toContain("21 merchants, A to Z");
		const narrowed = await get("/settings?rules_search=co");
		expect(narrowed.html).toContain('value="co"');
		expect(narrowed.html).toContain("2 merchants matching “co”");
		expect(narrowed.html).toContain("Paused while Groceries is archived");
		expect(narrowed.html).not.toContain("Merchant 01");
	});

	it("removing an Always rule leaves already sorted transactions unchanged", async () => {
		const merchant = "RULE REMOVE TEST";
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name, default_category_id) VALUES (?, 'Remove Test', 1)",
		)
			.bind(merchant)
			.run();
		const transaction = await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, merchant_name, category_id, category_source) VALUES (1, '2026-09-14', -1200, ?, ?, 1, 'merchant_rule') RETURNING id",
		)
			.bind(merchant, merchant)
			.first<{ id: number }>();
		const { res } = await post("/settings/merchant-rules/remove", { merchant });
		expect(res.status).toBe(200);
		expect(trigger(res).announce).toBe(
			"Removed the Always rule for Remove Test.",
		);
		expect(
			await env.DB.prepare(
				"SELECT default_category_id FROM merchants WHERE raw_name = ?",
			)
				.bind(merchant)
				.first(),
		).toEqual({ default_category_id: null });
		expect(
			await env.DB.prepare(
				"SELECT category_id, category_source FROM transactions WHERE id = ?",
			)
				.bind(transaction?.id)
				.first(),
		).toEqual({ category_id: 1, category_source: "merchant_rule" });
	});

	it("shows an empty state when there are no active categories", async () => {
		await env.DB.prepare("UPDATE categories SET archived = 1").run();
		const { html } = await get("/settings");
		expect(html).toContain("No active categories.");
		expect(html).toContain("Add one below, or restore an archived category.");
		expect(html).toContain("Archived (5)");
	});

	it("does not suggest restoring when there are no archived categories", async () => {
		await env.DB.prepare("DELETE FROM categories").run();
		const { html } = await get("/settings");
		expect(html).toContain("No active categories.");
		expect(html).toContain("Add one below.");
		expect(html).not.toContain("restore an archived category");
		expect(html).not.toContain("Archived (");
	});
});

describe("GET /settings?open=<id>", () => {
	it("opens that category's row", async () => {
		const { html } = await get("/settings?open=3");
		expect(html).toMatch(/<details[^>]*data-row="3"[^>]*\bopen/);
		expect(html).not.toMatch(/<details[^>]*data-row="1"[^>]*\bopen/);
	});
});

describe("saving a category", () => {
	it("renames it and says so", async () => {
		const { res, html } = await post("/settings/categories/1", {
			name: "Food at home",
		});
		expect(res.status).toBe(200);
		expect(rowNames(html)[0]).toBe("Food at home");
		expect(trigger(res)).toMatchObject({
			toast: { message: "Saved Food at home" },
			announce: "Saved Food at home.",
		});
	});

	it("keeps the row open with the error and what was typed when the name is taken", async () => {
		const { res, html } = await post("/settings/categories/1", {
			name: "gas",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/role="alert"[^>]*>That name is taken\./);
		expect(html).toMatch(/<details[^>]*data-row="1"[^>]*\bopen/);
		expect(html).toMatch(/name="name"[^>]*value="gas"/);
	});

	it("redirects back to Settings without JavaScript", async () => {
		const { res } = await post(
			"/settings/categories/1",
			{ name: "Groceries" },
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/settings");
	});

	it("is a 404 for a category that doesn't exist", async () => {
		const { res } = await post("/settings/categories/999", {
			name: "X",
		});
		expect(res.status).toBe(404);
	});

	it("moves focus back to the saved row", async () => {
		const { html } = await post("/settings/categories/3", {
			name: "Fuel",
		});
		expect(html).toMatch(/<summary data-category="3"[^>]*autofocus/);
	});
});

describe("a page left open while someone else changed a category", () => {
	it.each([
		["save", "/settings/categories/2"],
		["archive", "/settings/categories/2/archive"],
		["move", "/settings/categories/2/move/up"],
	])(
		"shows the current list with a message on %s, instead of emptying the section",
		async (_, path) => {
			await post("/settings/categories/2/archive", {});
			const { res, html } = await post(path, {
				name: "Eating Out",
			});
			expect(res.status).toBe(404);
			expect(html).toMatch(/<section id="categories"/);
			expect(html).toMatch(/role="alert"[^>]*>That category was changed/);
			expect(textOf(html)).toContain(
				"That category was changed somewhere else. Here's the current list.",
			);
		},
	);

	it("does the same on restore, once it's already back", async () => {
		const { res, html } = await post("/settings/categories/2/restore", {});
		expect(res.status).toBe(404);
		expect(html).toMatch(/<section id="categories"/);
		expect(html).toContain("That category was changed somewhere else.");
	});
});

describe("Cancel", () => {
	it("closes the row and moves focus back to it, so the change is announced", async () => {
		const { html: open } = await get("/settings?open=3");
		expect(open).toMatch(
			/<a href="\/settings"[^>]*hx-get="\/settings\?focus=3"[^>]*>Cancel<\/a>/,
		);
		const { html } = await get("/settings?focus=3");
		expect(html).toMatch(/<summary data-category="3"[^>]*autofocus/);
		expect(html).not.toMatch(/<details[^>]*data-row="3"[^>]*\bopen/);
	});
});

describe("a name taken by someone else at the same moment", () => {
	it("shows the usual error instead of failing", async () => {
		// The form's check passes, then the database refuses: the first save won.
		await env.DB.prepare(
			"CREATE TRIGGER sneak BEFORE INSERT ON categories BEGIN INSERT INTO categories (name, icon, color) VALUES ('travel', 'tag', 'cat-blue'); END",
		).run();
		const { res, html } = await post("/settings/categories", {
			name: "Travel",
		});
		await env.DB.prepare("DROP TRIGGER sneak").run();
		expect(res.status).toBe(422);
		expect(html).toContain("That name is taken.");
	});
});

describe("adding a category", () => {
	it("adds it at the end, with no budget yet", async () => {
		const { res, html } = await post("/settings/categories", {
			name: "Travel",
		});
		expect(res.status).toBe(200);
		expect(rowNames(html).at(-1)).toBe("Travel");
		expect(textOf(html)).toContain("No budget");
		// Focus lands on the new row, not back at the top of the page.
		const travel = await env.DB.prepare(
			"SELECT id FROM categories WHERE name = 'Travel'",
		).first<{ id: number }>();
		expect(html).toMatch(
			new RegExp(`<summary data-category="${travel?.id}"[^>]*autofocus`),
		);
		expect(html.match(/autofocus/g)).toHaveLength(1);
		expect(trigger(res).announce).toBe("Added Travel. Set its budget on Home.");
	});

	it("refuses Jev's reserved name, keeping the Add form open", async () => {
		const { res, html } = await post("/settings/categories", {
			name: "None of these fit",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/<details[^>]*data-row="new"[^>]*\bopen/);
		expect(html).toContain("That name is reserved for Tally. Pick another.");
	});
});

describe("archiving, restoring and moving", () => {
	it("archives a category into Archived, and restores it", async () => {
		const archived = await post("/settings/categories/2/archive", {});
		expect(rowNames(archived.html)).not.toContain("Eating Out");
		expect(archived.html).toContain("Archived (1)");
		expect(trigger(archived.res).announce).toBe(
			"Archived Eating Out. Its transactions keep their category.",
		);
		// The archived row is gone, so focus goes to where it went.
		expect(archived.html).toMatch(
			/<summary[^>]*autofocus[^>]*><span class="min-w-0 flex-1">Archived \(1\)<\/span>/,
		);

		const restored = await post("/settings/categories/2/restore", {});
		expect(rowNames(restored.html)).toContain("Eating Out");
		expect(restored.html).not.toContain("Archived (");
		expect(restored.html).toMatch(/<summary data-category="2"[^>]*autofocus/);
		expect(trigger(restored.res)).toEqual({
			toast: { message: "Restored Eating Out", type: "success" },
			announce: "Restored Eating Out.",
		});
	});

	it("won't restore past 50 active categories, and says why", async () => {
		await post("/settings/categories/2/archive", {});
		// The demo has 4 active now; add 46 more.
		await env.DB.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 46)
			 INSERT INTO categories (name, icon, color) SELECT 'Extra ' || i, 'tag', 'cat-blue' FROM n`,
		).run();
		const { res, html } = await post("/settings/categories/2/restore", {});
		expect(res.status).toBe(422);
		expect(html).toMatch(
			/role="alert"[^>]*>Tally has room for 50 categories\. Archive one to restore another\.</,
		);
		expect(rowNames(html)).not.toContain("Eating Out");
	});

	it("moves a category up, keeping its row open for another move", async () => {
		const { res, html } = await post("/settings/categories/3/move/up", {});
		expect(rowNames(html).slice(0, 3)).toEqual([
			"Groceries",
			"Gas",
			"Eating Out",
		]);
		expect(html).toMatch(/<details[^>]*data-row="3"[^>]*\bopen/);
		expect(html).toMatch(/<summary data-category="3"[^>]*autofocus/);
		expect(trigger(res).announce).toBe("Moved Gas up. It's now 2 of 5.");
	});
});
