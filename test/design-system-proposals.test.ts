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
	it("lists P8 as decided", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).toContain("P8 · Empty lists");
		expect(html).toContain(
			"Option B: a small drawing, one sentence and a hint, and at most one button, centred (decision 54).",
		);
		expect(DECIDED.length).toBe(8);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(`/issues/${d.issue}"`);
		}
	});

	it("opens P9, Accounts before any bank is linked, with three options in phone frames", async () => {
		const { html } = await get("/design-system/proposals");
		expect(html).not.toContain("No open proposals.");
		expect(html).toMatch(/<section id="p9-no-banks"[^>]*data-ds-tier="visual"/);
		expect(html).toContain("P9 · Accounts before any bank is linked");
		for (const option of [
			"Option A · A drawing under net worth",
			"Option B · Lead with the action",
			"Option C · A quiet line",
		]) {
			expect(html).toContain(option);
		}
		// Each option is a picture of a phone's first screen, described in words for screen readers.
		const frames = html.match(
			/role="img" aria-label="Accounts with no bank linked, option [ABC]/g,
		);
		expect(frames).toHaveLength(3);
		expect(html.match(/No banks linked yet\./g)?.length).toBeGreaterThanOrEqual(
			3,
		);
		expect(html.match(/>Link a bank</g)?.length).toBeGreaterThanOrEqual(3);
	});

	it("draws B without the $0 headline, and A and C with it", async () => {
		const { html } = await get("/design-system/proposals");
		const section = html.slice(html.indexOf('id="p9-no-banks"'));
		const option = (letter: string) => {
			const start = section.indexOf(`option ${letter}`);
			const next = section.indexOf("option ", start + 10);
			return section.slice(start, next === -1 ? undefined : next);
		};
		for (const letter of ["A", "C"]) {
			expect(option(letter)).toContain("Net worth");
			expect(option(letter)).toMatch(/>\$0</);
		}
		expect(option("B")).not.toContain("Net worth");
		expect(option("B")).not.toMatch(/>\$0</);
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
