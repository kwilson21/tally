import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { monthName, todayUtc } from "../src/dates";
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
const textOf = (html: string) => html.replace(/<[^>]+>/g, "");
const THIS_MONTH = () => monthName(todayUtc().slice(0, 7));
/** The names in the Categories list, in order. */
const rowNames = (html: string) =>
	[
		...html.matchAll(
			/<summary[^>]*data-category="\d+"[^>]*>[\s\S]*?<span class="[^"]*font-medium[^"]*">([^<]+)<\/span>/g,
		),
	].map((m) => m[1]);

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("GET /settings", () => {
	it("lists the categories with this month's budget, each opening in place to edit", async () => {
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
		expect(html).toContain(`Budget from ${THIS_MONTH()} on`);
		expect(html).toContain("Add category");
		// Nothing is archived yet, so there's no Archived section.
		expect(html).not.toContain("Archived (");
		// Every row starts closed.
		expect(html).not.toMatch(/<details[^>]*data-row[^>]*\bopen/);
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
	it("sets the budget from this month on, confirms it, and Home follows", async () => {
		const { res, html } = await post("/settings/categories/1", {
			name: "Groceries",
			budget: "650",
		});
		expect(res.status).toBe(200);
		expect(textOf(html)).toContain("$650 a month");
		expect(trigger(res)).toMatchObject({
			toast: { message: "Saved Groceries" },
			announce: `Saved. Groceries is $650 a month from ${THIS_MONTH()} on.`,
		});
		expect((await get("/")).html).toMatch(/of \$650/);
	});

	it("keeps the row open with the error and what was typed when the name is taken", async () => {
		const { res, html } = await post("/settings/categories/1", {
			name: "gas",
			budget: "650",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/role="alert"[^>]*>That name is taken\./);
		expect(html).toMatch(/<details[^>]*data-row="1"[^>]*\bopen/);
		expect(html).toMatch(/name="name"[^>]*value="gas"/);
		expect(html).toMatch(/name="budget"[^>]*value="650"/);
	});

	it("redirects back to Settings without JavaScript", async () => {
		const { res } = await post(
			"/settings/categories/1",
			{ name: "Groceries", budget: "650" },
			false,
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/settings");
	});

	it("is a 404 for a category that doesn't exist", async () => {
		const { res } = await post("/settings/categories/999", {
			name: "X",
			budget: "",
		});
		expect(res.status).toBe(404);
	});
});

describe("adding a category", () => {
	it("adds it at the end with its budget", async () => {
		const { res, html } = await post("/settings/categories", {
			name: "Travel",
			budget: "400",
		});
		expect(res.status).toBe(200);
		expect(rowNames(html).at(-1)).toBe("Travel");
		expect(textOf(html)).toContain("$400 a month");
		expect(trigger(res).announce).toBe(
			`Added Travel, $400 a month from ${THIS_MONTH()} on.`,
		);
	});

	it("refuses Jev's reserved name, keeping the Add form open", async () => {
		const { res, html } = await post("/settings/categories", {
			name: "None of these fit",
			budget: "",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/<details[^>]*data-row="new"[^>]*\bopen/);
		expect(html).toContain("That name is reserved for Jev. Pick another.");
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

		const restored = await post("/settings/categories/2/restore", {});
		expect(rowNames(restored.html)).toContain("Eating Out");
		expect(restored.html).not.toContain("Archived (");
	});

	it("moves a category up, keeping its row open for another move", async () => {
		const { res, html } = await post("/settings/categories/3/move/up", {});
		expect(rowNames(html).slice(0, 3)).toEqual([
			"Groceries",
			"Gas",
			"Eating Out",
		]);
		expect(html).toMatch(/<details[^>]*data-row="3"[^>]*\bopen/);
		expect(trigger(res).announce).toBe("Moved Gas up. It's now 2 of 5.");
	});
});
