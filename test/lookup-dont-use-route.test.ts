import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	CLEAR_COLUMNS,
	K1,
	LINE,
	lineRow,
	OTHER,
	rowOf,
	TEXT,
	useLineFixture,
} from "./lookup-line-fixture";

// #988: "Don't use this" on a store's lookup line, from the review card and from the edit panel.

const BASE = "http://tally.test";
const PATH = "/settings/suggestions";

async function post(path: string, fields: Record<string, string>, htmx = true) {
	const headers = {
		Origin: BASE,
		"content-type": "application/x-www-form-urlencoded",
	};

	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: htmx ? { ...headers, "HX-Request": "true" } : headers,
		body: new URLSearchParams(fields).toString(),
	});

	return { res, html: await res.text() };
}

// SAFETY: the HX-Trigger header is JSON this app writes itself, with the toast and announce keys named here.
const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};

// The store's name (its merchants row) differs from the one transaction's own name (This one only), so a toast that
// names the transaction instead of its store is caught.
const STORE_NAME = "Lupita's Taqueria";
const OWN_NAME = "Team lunch";
const STORE_SENTENCE = `Tally won't use the web for ${STORE_NAME} again.`;

async function nameStoreAndTransaction(id: number) {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO merchants (raw_name, display_name) VALUES (?, ?)",
		).bind(K1, STORE_NAME),
		env.DB.prepare("UPDATE transactions SET own_name = ? WHERE id = ?").bind(
			OWN_NAME,
			id,
		),
	]);
}

const GUESS_CHANGED = "That guess has changed, so nothing was dropped.";

// The bank now names another store for the row, while the old store's line is what the row was asked with.
const moveToOther = (id: number) =>
	env.DB.prepare(
		"UPDATE transactions SET raw_name = ?, merchant_name = ? WHERE id = ?",
	)
		.bind(OTHER, OTHER, id)
		.run();

// What a refused press must leave alone: the row's five guess columns and its lookup answer.
async function guessAndAnswer(id: number) {
	const { tx, answer } = await rowOf(id);
	const guess = Object.fromEntries(
		CLEAR_COLUMNS.map((c) => [c, tx[c] ?? null]),
	);

	return { guess, answer };
}

const lookupOf = (text: string) =>
	env.DB.prepare(
		"SELECT status, line FROM merchant_lookups WHERE lookup_text = ?",
	)
		.bind(text)
		.first<{ status: string; line: string | null }>();

describe("Don't use this on the review card (#988)", () => {
	useLineFixture();

	it("drops the line, shows the next card and toasts the store's sentence", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });

		const { res, html } = await post(PATH, {
			id: `category-${id}`,
			answer: "dont_use",
		});

		expect(res.status).toBe(200);
		expect(trigger(res).toast?.message).toContain("won't use the web for");
		expect(trigger(res).toast?.type).toBe("success");
		expect(trigger(res).announce).toBe(trigger(res).toast?.message);
		expect(html).not.toContain("From the web:");
		expect(await lookupOf(TEXT)).toEqual({ status: "skipped", line: null });
	});

	it("toasts the store's name, not the transaction's own name", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await nameStoreAndTransaction(id);

		const { res } = await post(PATH, {
			id: `category-${id}`,
			answer: "dont_use",
		});

		expect(trigger(res).toast?.message).toBe(STORE_SENTENCE);
		expect(trigger(res).announce).toBe(STORE_SENTENCE);
		expect(trigger(res).toast?.message).not.toContain(OWN_NAME);
		expect(trigger(res).announce).not.toContain(OWN_NAME);
	});

	it("without HX-Request redirects 303 to the review address", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });

		const { res } = await post(
			PATH,
			{ id: `category-${id}`, answer: "dont_use" },
			false,
		);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/settings/suggestions");
	});

	it("an id not in the queue answers That one was already answered. and writes nothing", async () => {
		const { res } = await post(PATH, {
			id: "category-999999",
			answer: "dont_use",
		});

		expect(trigger(res).toast?.message).toBe("That one was already answered.");
		expect(trigger(res).toast?.type).toBe("info");
	});

	it("a refused press redraws the card with the refusal's sentence as an info toast and writes nothing", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await env.DB.prepare(
			"UPDATE merchant_lookups SET status = 'pending' WHERE lookup_text = ?",
		)
			.bind(TEXT)
			.run();

		const { res } = await post(PATH, {
			id: `category-${id}`,
			answer: "dont_use",
		});

		expect(trigger(res).toast).toEqual({
			message: "That line is already gone.",
			type: "info",
		});
		expect((await lookupOf(TEXT))?.status).toBe("pending");
	});

	it("refuses a press for a transaction whose store moved, and writes nothing (#988)", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		const before = await guessAndAnswer(id);
		await moveToOther(id);

		const { res } = await post(PATH, {
			id: `category-${id}`,
			answer: "dont_use",
		});

		expect(trigger(res).toast).toEqual({ message: GUESS_CHANGED, type: "info" });
		expect(await lookupOf(TEXT)).toEqual({ status: "found", line: LINE });
		expect(await guessAndAnswer(id)).toEqual(before);
	});

	it("refuses a moved transaction whose old store's line is already skipped, with GuessChanged and no success toast (#988)", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await env.DB.prepare(
			"UPDATE merchant_lookups SET status = 'skipped', line = NULL WHERE lookup_text = ?",
		)
			.bind(TEXT)
			.run();
		const before = await guessAndAnswer(id);
		await moveToOther(id);

		const { res } = await post(PATH, {
			id: `category-${id}`,
			answer: "dont_use",
		});

		expect(trigger(res).toast).toEqual({ message: GUESS_CHANGED, type: "info" });
		expect(trigger(res).announce).toBe(GUESS_CHANGED);
		expect(JSON.stringify(trigger(res))).not.toContain(
			"Tally won't use the web for",
		);
		expect(await lookupOf(TEXT)).toEqual({ status: "skipped", line: null });
		expect(await guessAndAnswer(id)).toEqual(before);
	});

	it("a guess changed since the page was drawn is refused with its own sentence", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await env.DB.prepare(
			"UPDATE lookup_answers SET kept_confidence = 0.1 WHERE transaction_id = ?",
		)
			.bind(id)
			.run();

		const { res } = await post(PATH, {
			id: `category-${id}`,
			answer: "dont_use",
		});

		expect(trigger(res).toast?.message).toBe(
			"That guess has changed, so nothing was dropped.",
		);
		expect((await lookupOf(TEXT))?.status).toBe("found");
	});
});

describe("Don't use this in the edit panel (#988)", () => {
	useLineFixture();

	const route = (id: number) => `/transactions/${id}/lookup-line/dont-use`;

	it("answers with #edit-category alone, no guess line, focus on it, and the toast", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		const { res, html } = await post(route(id), { back: "/transactions" });

		expect(res.status).toBe(200);
		expect(html.trimStart().startsWith('<div id="edit-category"')).toBe(true);
		expect(html).toContain("autofocus");
		expect(html).toContain('tabindex="-1"');
		expect(html).not.toContain("From the web");
		expect(html).not.toContain("<h1");
		expect(trigger(res).toast?.type).toBe("success");
		expect(trigger(res).announce).toBe(trigger(res).toast?.message);
		expect(await lookupOf(TEXT)).toEqual({ status: "skipped", line: null });
	});

	it("toasts and announces the store's name, not the transaction's own name", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await nameStoreAndTransaction(id);

		const { res } = await post(route(id), { back: "/transactions" });

		expect(trigger(res).toast?.message).toBe(STORE_SENTENCE);
		expect(trigger(res).announce).toBe(STORE_SENTENCE);
		expect(trigger(res).toast?.message).not.toContain(OWN_NAME);
		expect(trigger(res).announce).not.toContain(OWN_NAME);
	});

	it("404 for an unknown id", async () => {
		const { res } = await post(route(999999), { back: "/transactions" });

		expect(res.status).toBe(404);
	});

	it("without HX-Request redirects 303 to /transactions/:id with back's query", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });

		const { res } = await post(
			route(id),
			{ back: "/transactions?month=2026-11" },
			false,
		);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(
			`/transactions/${id}?month=2026-11`,
		);
	});

	it("refuses a moved transaction whose old store's line is already skipped, with GuessChanged and writes nothing (#988)", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await env.DB.prepare(
			"UPDATE merchant_lookups SET status = 'skipped', line = NULL WHERE lookup_text = ?",
		)
			.bind(TEXT)
			.run();
		const before = await guessAndAnswer(id);
		await moveToOther(id);

		const { res, html } = await post(route(id), { back: "/transactions" });

		expect(html.trimStart().startsWith('<div id="edit-category"')).toBe(true);
		expect(trigger(res).toast).toEqual({ message: GUESS_CHANGED, type: "info" });
		expect(trigger(res).announce).toBe(GUESS_CHANGED);
		expect(JSON.stringify(trigger(res))).not.toContain(
			"Tally won't use the web for",
		);
		expect(await lookupOf(TEXT)).toEqual({ status: "skipped", line: null });
		expect(await guessAndAnswer(id)).toEqual(before);
	});

	it("a refusal redraws #edit-category with the info toast", async () => {
		const id = await lineRow({ key: K1, confidence: 0.5 });
		await env.DB.prepare(
			"UPDATE merchant_lookups SET status = 'pending' WHERE lookup_text = ?",
		)
			.bind(TEXT)
			.run();

		const { res, html } = await post(route(id), { back: "/transactions" });

		expect(html.trimStart().startsWith('<div id="edit-category"')).toBe(true);
		expect(trigger(res).toast).toEqual({
			message: "That line is already gone.",
			type: "info",
		});
	});
});
