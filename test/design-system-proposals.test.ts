import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NAME_PAIRS } from "../src/design-system/proposals";
import { designSystem } from "../src/routes/design-system";

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;

describe("GET /design-system/proposals", () => {
	it("shows each undecided proposal next to today's version", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		for (const id of ["p1", "p2", "p3", "p4"]) {
			expect(html).toMatch(new RegExp(`<section[^>]*id="${id}"`));
		}
		expect(html.match(/>Today</g)?.length).toBeGreaterThanOrEqual(4);
		expect(html.match(/>Proposed</g)?.length).toBeGreaterThanOrEqual(3);
	});

	it("shows the raw bank names today and the tidied ones proposed", async () => {
		const { html } = await get("/design-system/proposals");
		for (const [raw, tidy] of NAME_PAIRS) {
			expect(html).toContain(raw.replaceAll("&", "&amp;"));
			expect(html).toContain(tidy);
		}
	});

	it("is Visual: inert to htmx, and blocks form posts", async () => {
		const { res, html } = await get("/design-system/proposals");
		const tags = [...html.matchAll(/<section[^>]*data-ds-tier="[^"]*"[^>]*>/g)];
		expect(tags.length).toBe(4);
		for (const [tag] of tags) expect(tag).toContain("hx-ignore");
		expect(res.headers.get("content-security-policy")).toContain(
			"form-action 'none'",
		);
	});

	it("shows pictures, not live controls: the phone frames and P3's money input are inert", async () => {
		const { html } = await get("/design-system/proposals");
		expect(html.match(/role="img"[^>]*>\s*<div inert/g)?.length).toBe(2);
		expect(html).toMatch(/<div inert[^>]*>\s*<div data-money/);
	});

	it("draws each phone frame a real phone's width: 390 inside a 1px border", async () => {
		const { html } = await get("/design-system/proposals");
		expect(html.match(/w-\[392px\] shrink-0/g)?.length).toBe(2);
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
