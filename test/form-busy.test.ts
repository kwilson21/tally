import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const get = async (path: string) => {
	const response = await exports.default.fetch(BASE + path);
	return response.text();
};

const htmxForms = (html: string) =>
	[...html.matchAll(/<form\b[^>]*hx-post="[^"]+"[^>]*>[\s\S]*?<\/form>/g)].map(
		(match) => match[0],
	);

beforeEach(async () => {
	await resetDemo(env.DB, todayUtc());
});

describe("htmx posting forms", () => {
	it("disable every submit button and label Home's save while it is busy", async () => {
		const sheet = await get("/budget/1");
		const forms = htmxForms(sheet);
		expect(forms).toHaveLength(1);
		expect(forms[0]).toContain('hx-disable="findAll button[type=submit]"');
		expect(forms[0]).toContain("Saving…");

		const adjust = await get("/?adjust=1");
		for (const form of htmxForms(adjust)) {
			expect(form).toContain('hx-disable="findAll button[type=submit]"');
			expect(form).not.toContain("button-spinner");
		}
	});

	it("disable every Settings submit button and show action-specific labels", async () => {
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 5",
		).run();
		const html = await get("/settings");
		const forms = htmxForms(html);
		expect(forms.length).toBeGreaterThan(0);
		for (const form of forms) {
			expect(form).toContain('hx-disable="findAll button[type=submit]"');
		}
		for (const label of [
			"Saving…",
			"Adding…",
			"Archiving…",
			"Restoring…",
			"Moving…",
		]) {
			expect(html).toContain(label);
		}
	});

	it("disables the transaction editor submit button and labels its save", async () => {
		const transaction = await env.DB.prepare(
			"SELECT id FROM transactions LIMIT 1",
		).first<{ id: number }>();
		const html = await get(`/transactions/${transaction?.id}`);
		const forms = htmxForms(html);
		expect(forms).toHaveLength(1);
		expect(forms[0]).toContain('hx-disable="findAll button[type=submit]"');
		expect(forms[0]).toContain("Saving…");
	});
});
