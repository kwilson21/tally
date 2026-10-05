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
	it("shows P23–P72 with one recommended option each, marks the owner's picks from P34 on, and lists every decided proposal", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		expect(html).not.toContain('id="p22-counts"');
		const ids = [...html.matchAll(/<section id="(p\d+[a-z0-9-]*)"/g)].map(
			(m) => m[1] ?? "",
		);
		// Every proposal from P23 to P71 is drawn, and each id is used once.
		const numbers = new Set(ids.map((id) => Number(id.match(/^p(\d+)/)?.[1])));
		for (let n = 23; n <= 75; n++) expect(numbers.has(n)).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);
		// P31 (empty and early states) is signed off as drawn, so it has no options to weigh. Every
		// other proposal marks exactly one Recommended, with its reason.
		for (const id of ids) {
			const start = html.indexOf(`<section id="${id}"`);
			// Up to the next proposal (a picture can hold sections of its own).
			const next = html.indexOf('<section id="p', start + 1);
			const section = html.slice(start, next === -1 ? undefined : next);
			const recommended = section.match(/>Recommended</g)?.length ?? 0;
			expect([id, recommended]).toEqual([id, id === "p31-empty" ? 0 : 1]);
			expect(section.match(/text-muted">Why: /g)?.length ?? 0).toBe(
				recommended,
			);
			// P34–P75 mark the owner's pick (decisions 72–76); P60 took two options. Later ones are open.
			const n = Number(id.match(/^p(\d+)/)?.[1]);
			const picked = section.match(/>Picked</g)?.length ?? 0;
			const expected = n < 34 || n > 75 ? 0 : id === "p60-bills-total" ? 2 : 1;
			expect([id, picked]).toEqual([id, expected]);
		}
		// Every option is a picture of a screen: labelled, and nothing inside to Tab to.
		const options = html.match(/<h4 /g)?.length ?? 0;
		const pictures =
			html.match(/role="img" aria-label="[^"]*, on (a phone|desktop)"/g)
				?.length ?? 0;
		expect(pictures).toBe(options);
		// …and each picture has something drawn in it, not an empty frame.
		expect(html.match(/<div data-screen="picture">/g)?.length ?? 0).toBe(
			options,
		);
		expect(html).not.toMatch(/<div data-screen="picture">\s*<\/div>/);
		expect(DECIDED.length).toBe(42);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(d.outcome.replaceAll("'", "&#39;"));
			if (d.issue) expect(html).toContain(`/issues/${d.issue}"`);
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
