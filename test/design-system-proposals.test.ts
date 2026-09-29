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
	it("shows P15–P22 open with two options each, and lists P1–P14 as decided", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		expect(html).not.toContain('id="p14-feedback"');
		const open = [
			"p15-bills",
			"p16-bill",
			"p17-split",
			"p18-found",
			"p19-refund",
			"p20-select",
			"p21-cash",
			"p22-counts",
		];
		for (const id of open) expect(html).toContain(`id="${id}"`);
		// Each proposal marks exactly one option Recommended, with its reason.
		expect(html.match(/>Recommended</g)?.length).toBe(open.length);
		expect(html.match(/Why: /g)?.length).toBe(open.length);
		// Every option is a picture of a screen: labelled, and nothing inside to Tab to.
		expect(
			html.match(/role="img" aria-label="[^"]*, on a phone"/g)?.length,
		).toBe(20);
		expect(
			html.match(/role="img" aria-label="[^"]*, on desktop"/g)?.length,
		).toBe(1);
		expect(DECIDED.length).toBe(14);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(d.outcome.replaceAll("'", "&#39;"));
			expect(html).toContain(`/issues/${d.issue}"`);
		}
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
