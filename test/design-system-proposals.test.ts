import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DECIDED } from "../src/design-system/proposals";
import { designSystem } from "../src/routes/design-system";

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;

describe("GET /design-system/proposals", () => {
	it("says nothing is open, and lists every decision with its issue", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).toContain("Nothing waiting");
		expect(DECIDED.length).toBe(7);
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
