import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { K1, lineRow, TEXT, useLineFixture } from "./lookup-line-fixture";

// #988: "Don't use this" on a store's lookup line, from the review card and from the edit panel.

const BASE = "http://tally.test";
const PATH = "/settings/suggestions";

async function post(
	path: string,
	fields: Record<string, string>,
	htmx = true,
) {
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

const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};

const lookupOf = (text: string) =>
	env.DB.prepare("SELECT status, line FROM merchant_lookups WHERE lookup_text = ?")
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
