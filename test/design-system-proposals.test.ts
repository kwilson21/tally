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
	it("shows P14's icon options on phones, and lists P8–P14 as decided", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		for (const id of ["p14-feedback"]) {
			expect(html).toContain(`id="${id}"`);
		}
		// Every option is a picture of a phone screen: labelled, and nothing inside to Tab to.
		expect(
			html.match(/role="img" aria-label="[^"]*, on a phone"/g)?.length,
		).toBe(2);
		expect(html).toContain("P8 · Empty lists");
		expect(html).toContain("P9 · Accounts before any bank is linked");
		expect(html).toContain(
			"Option B: no $0 headline yet; the drawing with an add sign, one sentence, a hint that Tally only reads, and Link a bank, centred (decision 55).",
		);
		expect(html).not.toContain('id="p9-no-banks"');
		expect(DECIDED.length).toBe(14);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
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
