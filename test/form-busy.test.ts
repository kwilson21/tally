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
	it("makes each sheet's Save its own busy indicator, so it stays full colour while it works", async () => {
		expect(await get("/budget/1")).toMatch(
			/<form[^>]*hx-indicator="#budget-save"[^>]*>[\s\S]*?<button[^>]*id="budget-save"/,
		);
		const transaction = await env.DB.prepare(
			"SELECT id FROM transactions LIMIT 1",
		).first<{ id: number }>();
		expect(await get(`/transactions/${transaction?.id}`)).toMatch(
			/<form[^>]*hx-indicator="#edit-save"[^>]*>[\s\S]*?<button[^>]*id="edit-save"/,
		);
	});

	it("disable every submit button and label Home's save while it is busy", async () => {
		const sheet = await get("/budget/1");
		const forms = htmxForms(sheet);
		expect(forms).toHaveLength(1);
		expect(forms[0]).toContain('hx-disable="findAll button[type=submit]"');
		expect(forms[0]).toContain("Saving…");

		const adjust = await get("/?adjust=1");
		for (const form of htmxForms(adjust)) {
			expect(form).not.toContain("hx-disable");
			expect(form).not.toContain("button-spinner");
		}
	});

	it("uses each Settings form's primary button as its busy indicator", async () => {
		await env.DB.prepare(
			"UPDATE categories SET archived = 1 WHERE id = 5",
		).run();
		const html = await get("/settings");
		const forms = htmxForms(html);
		expect(forms.length).toBeGreaterThan(0);
		expect(html).toMatch(
			/<form[^>]*id="cat-1-form"[^>]*hx-indicator="#cat-1-save"[^>]*>[\s\S]*?<button[^>]*id="cat-1-save"/,
		);
		expect(html).toMatch(
			/<form[^>]*hx-indicator="#new-category-save"[^>]*>[\s\S]*?<button[^>]*id="new-category-save"/,
		);
		expect(html).toMatch(
			/<form[^>]*hx-indicator="#cat-5-restore"[^>]*>[\s\S]*?<button[^>]*id="cat-5-restore"/,
		);
		for (const actionId of [
			"cat-1-archive",
			"cat-2-move-up",
			"cat-2-move-down",
		]) {
			expect(html).toMatch(
				new RegExp(
					`<button[^>]*id="${actionId}"[^>]*hx-disable="#cat-[0-9]+-form button\\[type=submit\\]"`,
				),
			);
		}
		expect(html).not.toMatch(
			/id="cat-(?:1-archive|2-move-(?:up|down))"[^>]*hx-indicator/,
		);
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
