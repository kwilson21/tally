import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { undoRemainingMs } from "../src/db/learned-lines";
import { resetDemo } from "../src/demo/reset";

// The Undo's remaining time is the server's own, counted from the stored forgotten_at, so a Forget written seconds ago
// offers only what is left; under a second, no Undo is offered. The Undo itself refuses after ten seconds. A long
// unbroken bank text wraps inside its line and keeps its Forget button in the row.

const db = env.DB;
const BASE = "http://tally.test";

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);

	return { res, html: await res.text() };
}

async function post(path: string, fields: Record<string, string>) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
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
		};
	};

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

async function answer(raw: string, category: string) {
	await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, category_id, category_source)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 1499, ?, ?, 'user')`,
		)
		.bind(`plaid-${crypto.randomUUID()}`, raw, await categoryId(category))
		.run();
}

/** A Forget row whose time is `seconds` before now, on the database's clock (fractions allowed). */
async function writtenAgo(seconds: number): Promise<number> {
	const row = await db
		.prepare(
			"INSERT INTO forgotten_texts (cleaned_text, forgotten_at) VALUES ('netflix.com', strftime('%Y-%m-%d %H:%M:%f', 'now', ?)) RETURNING id",
		)
		.bind(`-${seconds} seconds`)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

beforeEach(async () => {
	await resetDemo(db, "2026-10-15");
	await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO categories (name, name_key, icon, color, sort_order) VALUES ('Entertainment', 'entertainment', 'entertainment', 'cat-blue', 90)",
		),
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM forgotten_texts"),
	]);
});

describe("the Undo's remaining time", () => {
	it("a Forget written 4 s ago has about 6 s of Undo left", async () => {
		const ms = await undoRemainingMs(db, await writtenAgo(4));
		expect(ms).toBeGreaterThanOrEqual(5800);
		expect(ms).toBeLessThanOrEqual(6000);
	});

	it("a Forget written 9.5 s ago has under a second left", async () => {
		expect(await undoRemainingMs(db, await writtenAgo(9.5))).toBeLessThan(1000);
	});

	it("a Forget written 10.5 s ago is no longer undone: the server refuses the Undo", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		const id = await writtenAgo(10.5);

		const undo = await post("/settings/learned/undo", {
			token: String(id),
			back: "/settings/learned",
		});

		expect(trigger(undo.res).toast).toMatchObject({
			type: "error",
			message: "Undo expired. The line stays forgotten.",
		});
	});

	it("a fresh Forget offers its Undo with about ten seconds, counted from the server", async () => {
		await answer("NETFLIX.COM", "Entertainment");

		const toast = trigger(
			(await post("/settings/learned/forget", { text: "netflix.com" })).res,
		).toast;

		expect(toast?.undo).toMatch(/^\d+$/);
		expect(toast?.undoExpiresInMs).toBeGreaterThanOrEqual(9000);
		expect(toast?.undoExpiresInMs).toBeLessThanOrEqual(10000);
	});

	it("a second Forget's Undo is counted from its own stored time", async () => {
		await answer("NETFLIX.COM", "Entertainment");
		await post("/settings/learned/forget", { text: "netflix.com" });
		await db
			.prepare("UPDATE transactions SET updated_at = '2000-01-01 00:00:00'")
			.run();
		await db
			.prepare(
				"UPDATE forgotten_texts SET forgotten_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-4 seconds')",
			)
			.run();
		await answer("NETFLIX.COM", "Entertainment");

		const toast = trigger(
			(await post("/settings/learned/forget", { text: "netflix.com" })).res,
		).toast;

		// The second Forget writes a fresh time, so its Undo is about ten seconds, not the four the first had left.
		expect(toast?.undoExpiresInMs).toBeGreaterThanOrEqual(9000);
	});
});

describe("a learned line with a long unbroken name", () => {
	it("wraps its name anywhere, and its text block may shrink so the Forget button stays in the row", async () => {
		await answer(
			"SUPERCALIFRAGILISTICEXPIALIDOCIOUSMERCHANTNAME",
			"Entertainment",
		);
		const { html } = await get("/settings/learned");
		expect(html).toMatch(
			/<span class="min-w-0 flex-1">\s*<span class="block text-lg leading-6 wrap-anywhere">Supercalifragilisticexpialidociousmerchantname → Entertainment<\/span>/,
		);
		expect(html).toMatch(/<form[^>]*class="[^"]*shrink-0/);
	});
});
