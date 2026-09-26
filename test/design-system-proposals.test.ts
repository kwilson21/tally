import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DECIDED, LIMIT_OPTIONS } from "../src/design-system/proposals";
import { designSystem } from "../src/routes/design-system";

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;

describe("GET /design-system/proposals", () => {
	it("shows the open proposal's options, and what was decided", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).toMatch(/<section[^>]*id="p5"/);
		for (const opt of LIMIT_OPTIONS) expect(html).toContain(opt.title);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(`/issues/${d.issue}"`);
		}
	});

	it("never draws the black limit line, and keeps over budget in words", async () => {
		const { html } = await get("/design-system/proposals");
		const p5 = html.split('id="p5"')[1] ?? "";
		expect(p5).not.toContain("stroke-ink");
		// Two over-budget rows in each of the three options.
		expect(p5.match(/\$36 over/g)?.length).toBe(3);
		expect(p5.match(/\$150 over/g)?.length).toBe(3);
	});

	it("is Visual: inert to htmx, and blocks form posts", async () => {
		const { res, html } = await get("/design-system/proposals");
		const tags = [...html.matchAll(/<section[^>]*data-ds-tier="[^"]*"[^>]*>/g)];
		expect(tags.length).toBe(1);
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
