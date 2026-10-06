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
	it("draws P63's Accounts top with a net-worth line that ends on the headline above it", async () => {
		const { html } = await get("/design-system/proposals");
		const start = html.indexOf('id="p63-account-filter"');
		expect(start).toBeGreaterThan(-1);
		expect(html.slice(start)).toContain("$23,400");
		expect(html.slice(start)).toContain("and is $23,400 today.");
	});

	it("shows P23–P94 with one recommended option each, marks the owner's picks from P34 on, and lists every decided proposal", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		expect(html).not.toContain('id="p22-counts"');
		const ids = [...html.matchAll(/<section id="(p\d+[a-z0-9-]*)"/g)].map(
			(m) => m[1] ?? "",
		);
		// Every proposal from P23 to P94 is drawn, and each id is used once.
		const numbers = new Set(ids.map((id) => Number(id.match(/^p(\d+)/)?.[1])));
		for (let n = 23; n <= 94; n++) expect(numbers.has(n)).toBe(true);
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
			// P34–P94 mark the owner's pick (decisions 72–82); P60 and P92 took two options.
			const n = Number(id.match(/^p(\d+)/)?.[1]);
			const picked = section.match(/>Picked</g)?.length ?? 0;
			const expected =
				n < 34
					? 0
					: id === "p60-bills-total" || id === "p92-delete-cash"
						? 2
						: 1;
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
		expect(DECIDED.length).toBe(61);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(d.outcome.replaceAll("'", "&#39;"));
			if (d.issue) expect(html).toContain(`/issues/${d.issue}"`);
		}
	});

	it("draws the owner's four polish picks (P91–P94, decision 82) as the app now words them", async () => {
		const { html } = await get("/design-system/proposals");
		const section = (id: string) => {
			const start = html.indexOf(`<section id="${id}"`);
			expect(start).toBeGreaterThan(-1);
			const next = html.indexOf('<section id="p', start + 1);
			return html.slice(start, next === -1 ? undefined : next);
		};
		// One option's heading and picture, up to the next option's heading.
		const option = (sectionHtml: string, name: string) => {
			const heads = [...sectionHtml.matchAll(/<h4 /g)].map((m) => m.index ?? 0);
			const at = heads.find((i) =>
				sectionHtml.slice(i, i + 400).includes(`>${name}`),
			);
			expect(at, name).toBeDefined();
			const next = heads.find((i) => i > (at ?? 0));
			return sectionHtml.slice(at, next);
		};
		const picked = (chunk: string) => chunk.includes(">Picked<");

		// P91: More without Documents is picked; today's More lists it and leads to a page that isn't built.
		const p91 = section("p91-documents-menu");
		const p91a = option(p91, "Option A · ");
		expect(picked(p91a)).toBe(true);
		expect(p91a).toContain(">Accounts<");
		expect(p91a).toContain(">How Tally works<");
		expect(p91a).not.toContain(">Documents<");
		const p91b = option(p91, "Option B · ");
		expect(picked(p91b)).toBe(false);
		expect(p91b).toContain(">Documents<");
		expect(option(p91, "Option B, next · ")).toContain(
			"This part of Tally isn&#39;t built yet.",
		);
		expect(p91).toContain("decision 82");

		// P92: B (the question) and D (the toast's Undo) are picked; the others aren't.
		const p92 = section("p92-delete-cash");
		const question = "Delete Farmers market, $20.00? This can&#39;t be undone.";
		const today = option(p92, "Today · ");
		expect(picked(today)).toBe(false);
		expect(today).toContain("Delete this cash entry?");
		expect(today).toContain(">Save<");
		const p92a = option(p92, "Option A · ");
		expect(picked(p92a)).toBe(false);
		expect(p92a).toContain("Delete this cash entry?");
		const p92b = option(p92, "Option B · ");
		expect(picked(p92b)).toBe(true);
		expect(p92b).toContain(question);
		expect(p92b).toContain(">Delete<");
		expect(p92b).toContain(">Keep it<");
		// The question takes the place of Cancel and Save.
		expect(p92b).not.toContain(">Save<");
		expect(p92b).not.toContain(">Cancel<");
		const p92c = option(p92, "Option C · ");
		expect(picked(p92c)).toBe(false);
		expect(p92c).toContain("Delete Farmers market, $20.00?");
		const p92d = option(p92, "Option D · ");
		expect(picked(p92d)).toBe(true);
		expect(p92d).toContain("Deleted Farmers market, $20.00.");
		expect(p92d).toContain(">Undo<");
		const p92e = option(p92, "Option E · ");
		expect(picked(p92e)).toBe(false);
		expect(p92e).toContain("bg-over");
		expect(p92).toContain("its own issue");

		// P93: with the off line first (picked), it sits right under the title, before the privacy text;
		// today's page puts it after.
		const p93 = section("p93-demo-feedback");
		const off =
			"Feedback is off in the demo. Sign in to your Tally to send it.";
		const privacy = "Before a new report is sent";
		const p93a = option(p93, "Option A · ");
		expect(picked(p93a)).toBe(true);
		expect(p93a.indexOf(off)).toBeGreaterThan(-1);
		expect(p93a.indexOf(off)).toBeLessThan(p93a.indexOf(privacy));
		const p93b = option(p93, "Option B · ");
		expect(picked(p93b)).toBe(false);
		expect(p93b.indexOf(off)).toBeGreaterThan(p93b.indexOf(privacy));

		// P94: the link under the status sentence (picked) goes to Bills' section; today's has none.
		const p94 = section("p94-bills-how-link");
		const p94a = option(p94, "Option A · ");
		expect(picked(p94a)).toBe(true);
		expect(p94a).toContain('href="/how-it-works#bills"');
		expect(p94a).toContain('aria-label="How this works: bills"');
		const p94b = option(p94, "Option B · ");
		expect(picked(p94b)).toBe(false);
		expect(p94b).not.toContain("/how-it-works#bills");
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
