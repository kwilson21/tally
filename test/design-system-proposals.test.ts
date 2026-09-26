import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NUDGE_OPTIONS, nudgedTo } from "../src/design-system/proposal-nudges";
import { DECIDED } from "../src/design-system/proposals";
import { designSystem } from "../src/routes/design-system";

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;

describe("GET /design-system/proposals", () => {
	it("shows P6's three options, and lists every decision with its issue", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).toMatch(/<section[^>]*id="p6"/);
		// Today's version comes first, drawn by the real component.
		const p6 = html.split('id="p6"')[1] ?? "";
		expect(p6.indexOf(">Today<")).toBeGreaterThan(-1);
		expect(p6.indexOf(">Today<")).toBeLessThan(p6.indexOf("Option A"));
		for (const opt of NUDGE_OPTIONS)
			expect(html).toContain(opt.title.replaceAll("'", "&#39;"));
		expect(DECIDED.length).toBe(5);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(`/issues/${d.issue}"`);
		}
	});

	it("is Visual: inert to htmx, and blocks form posts", async () => {
		const { res, html } = await get("/design-system/proposals");
		const tags = [...html.matchAll(/<section[^>]*data-ds-tier="[^"]*"[^>]*>/g)];
		expect(tags.length).toBeGreaterThan(0);
		for (const [tag] of tags) expect(tag).toContain("hx-ignore");
		expect(res.headers.get("content-security-policy")).toContain(
			"form-action 'none'",
		);
	});

	it("is linked from the catalog", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('href="/design-system/proposals"');
	});

	it("doesn't exist in production", async () => {
		const res = await designSystem.request(
			"/design-system/proposals",
			{},
			notDemo,
		);
		expect(res.status).toBe(404);
	});
});

describe("nudgedTo (P6's round $10 steps)", () => {
	it("goes to the next round $10 up or down", () => {
		expect(nudgedTo(71200, 1)).toBe(72000);
		expect(nudgedTo(71200, -1)).toBe(71000);
	});

	it("steps a full $10 from an amount that's already round", () => {
		expect(nudgedTo(72000, 1)).toBe(73000);
		expect(nudgedTo(72000, -1)).toBe(71000);
	});

	it("never goes below $0", () => {
		expect(nudgedTo(500, -1)).toBe(0);
		expect(nudgedTo(0, -1)).toBe(0);
		expect(nudgedTo(0, 1)).toBe(1000);
	});
});
