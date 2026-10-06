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

	it("shows P23–P90 and P110–P116 with one recommended option each, marks the owner's picks from P34 on, and lists every decided proposal", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Proposals · Design system · Tally</title>");
		expect(html).not.toContain("No open proposals.");
		expect(html).not.toContain('id="p22-counts"');
		const ids = [...html.matchAll(/<section id="(p\d+[a-z0-9-]*)"/g)].map(
			(m) => m[1] ?? "",
		);
		// Every proposal from P23 to P90, and P110 to P116, is drawn, and each id is used once. P91–P109
		// are the build session's Phase 5 picks (decision 82), drawn in their own PR.
		const numbers = new Set(ids.map((id) => Number(id.match(/^p(\d+)/)?.[1])));
		for (let n = 23; n <= 116; n++)
			if (n <= 90 || n >= 110) expect(numbers.has(n)).toBe(true);
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
			// P34 on mark the owner's pick (decisions 72–85); P60 and P111 took two options.
			const n = Number(id.match(/^p(\d+)/)?.[1]);
			const picked = section.match(/>Picked</g)?.length ?? 0;
			const expected =
				n < 34
					? 0
					: id === "p60-bills-total" || id === "p111-delete-cash"
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
		expect(DECIDED.length).toBe(64);
		for (const d of DECIDED) {
			expect(html).toContain(d.title.replaceAll("'", "&#39;"));
			expect(html).toContain(d.outcome.replaceAll("'", "&#39;"));
			if (d.issue) expect(html).toContain(`/issues/${d.issue}"`);
		}
	});

	it("draws the owner's four polish picks (P110–P113, decision 84) as the app now words them", async () => {
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

		// P110: More without Documents is picked; today's More lists it and leads to a page that isn't built.
		const p110 = section("p110-documents-menu");
		const p110a = option(p110, "Option A · ");
		expect(picked(p110a)).toBe(true);
		expect(p110a).toContain(">Accounts<");
		expect(p110a).toContain(">How Tally works<");
		expect(p110a).not.toContain(">Documents<");
		const p110b = option(p110, "Option B · ");
		expect(picked(p110b)).toBe(false);
		expect(p110b).toContain(">Documents<");
		expect(option(p110, "Option B, next · ")).toContain(
			"This part of Tally isn&#39;t built yet.",
		);
		expect(p110).toContain("decision 84");

		// P111: B (the question) and D (the toast's Undo) are picked; the others aren't.
		const p111 = section("p111-delete-cash");
		const question = "Delete Farmers market, $20.00? This can&#39;t be undone.";
		const today = option(p111, "Today · ");
		expect(picked(today)).toBe(false);
		expect(today).toContain("Delete this cash entry?");
		expect(today).toContain(">Save<");
		const p111a = option(p111, "Option A · ");
		expect(picked(p111a)).toBe(false);
		expect(p111a).toContain("Delete this cash entry?");
		const p111b = option(p111, "Option B · ");
		expect(picked(p111b)).toBe(true);
		expect(p111b).toContain(question);
		expect(p111b).toContain(">Delete<");
		expect(p111b).toContain(">Keep it<");
		// The question takes the place of Cancel and Save.
		expect(p111b).not.toContain(">Save<");
		expect(p111b).not.toContain(">Cancel<");
		const p111c = option(p111, "Option C · ");
		expect(picked(p111c)).toBe(false);
		expect(p111c).toContain("Delete Farmers market, $20.00?");
		const p111d = option(p111, "Option D · ");
		expect(picked(p111d)).toBe(true);
		expect(p111d).toContain("Deleted Farmers market, $20.00.");
		expect(p111d).toContain(">Undo<");
		const p111e = option(p111, "Option E · ");
		expect(picked(p111e)).toBe(false);
		expect(p111e).toContain("bg-over");
		expect(p111).toContain("its own issue");

		// P112: with the off line first (picked), it sits right under the title, before the privacy text;
		// today's page puts it after.
		const p112 = section("p112-demo-feedback");
		const off =
			"Feedback is off in the demo. Sign in to your Tally to send it.";
		const privacy = "Before a new report is sent";
		const p112a = option(p112, "Option A · ");
		expect(picked(p112a)).toBe(true);
		expect(p112a.indexOf(off)).toBeGreaterThan(-1);
		expect(p112a.indexOf(off)).toBeLessThan(p112a.indexOf(privacy));
		const p112b = option(p112, "Option B · ");
		expect(picked(p112b)).toBe(false);
		expect(p112b.indexOf(off)).toBeGreaterThan(p112b.indexOf(privacy));

		// P113: the link under the status sentence (picked) goes to Bills' section; today's has none.
		const p113 = section("p113-bills-how-link");
		const p113a = option(p113, "Option A · ");
		expect(picked(p113a)).toBe(true);
		expect(p113a).toContain('href="/how-it-works#bills"');
		expect(p113a).toContain('aria-label="How this works: bills"');
		const p113b = option(p113, "Option B · ");
		expect(picked(p113b)).toBe(false);
		expect(p113b).not.toContain("/how-it-works#bills");
	});

	it("draws the owner's picks on Q60–Q62 (P114–P116, decision 85) as the app will have them", async () => {
		const { html } = await get("/design-system/proposals");
		const section = (id: string) => {
			const start = html.indexOf(`<section id="${id}"`);
			expect(start).toBeGreaterThan(-1);
			const next = html.indexOf('<section id="p', start + 1);
			return html.slice(start, next === -1 ? undefined : next);
		};
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
		const recommended = (chunk: string) => chunk.includes(">Recommended<");
		// An option's picture alone. The heading and note above it quote the very words asserted
		// below, so asserting on the whole option would pass with the picture changed or emptied.
		const picture = (chunk: string) => {
			const at = chunk.indexOf('data-screen="picture"');
			expect(at).toBeGreaterThan(-1);
			return chunk.slice(at);
		};
		const cant = "This can&#39;t be undone.";

		// P114: once Undo ships, the sheet asks only the question; Delete and Keep it are its answers.
		const p114 = section("p114-delete-wording");
		const p114a = option(p114, "Option A · Just the question");
		expect(picked(p114a) && recommended(p114a)).toBe(true);
		const p114aPicture = picture(p114a);
		expect(p114aPicture).toContain(">Delete Farmers market, $20.00?</p>");
		expect(p114aPicture).not.toContain(cant);
		expect(p114aPicture).not.toContain("undo it");
		expect(p114aPicture).toContain(">Delete<");
		expect(p114aPicture).toContain(">Keep it<");
		const p114b = option(p114, "Option B · ");
		expect(picked(p114b)).toBe(false);
		expect(picture(p114b)).toContain(
			`>Delete Farmers market, $20.00? ${cant}</p>`,
		);
		const p114c = option(p114, "Option C · ");
		expect(picked(p114c)).toBe(false);
		expect(picture(p114c)).toContain(
			">Delete Farmers market, $20.00? You can undo it for 10 seconds.</p>",
		);
		expect(picture(p114c)).not.toContain(cant);
		expect(p114).toContain("decision 85");

		// P115: the money box in the 12px control corner (picked); B keeps the 8px it had. Date and
		// Where are in both pictures and use rounded-control, so the money box is found by its own
		// markup: its box by its fixed size, its cent arrows by their outer corners.
		const p115 = section("p115-money-corners");
		const box = (pic: string) =>
			pic.match(/<div class="([^"]*min-h-\[90px\][^"]*)"/)?.[1] ?? "";
		const p115a = option(p115, "Option A · ");
		expect(picked(p115a) && recommended(p115a)).toBe(true);
		const p115aPicture = picture(p115a);
		expect(p115aPicture).toContain("data-money");
		expect(box(p115aPicture)).toContain("rounded-control");
		expect(p115aPicture).toContain("rounded-tr-control");
		expect(p115aPicture).toContain("rounded-br-control");
		expect(p115aPicture).not.toContain("rounded-lg");
		expect(p115aPicture).not.toContain("rounded-tr-lg");
		const p115b = option(p115, "Option B · ");
		expect(picked(p115b)).toBe(false);
		const p115bPicture = picture(p115b);
		expect(p115bPicture).toContain("data-money");
		// B's wrapper turns all three of the money box's corners back to 8px, and only those.
		for (const [control, eight] of [
			["rounded-control", "rounded-lg"],
			["rounded-tr-control", "rounded-tr-lg"],
			["rounded-br-control", "rounded-br-lg"],
		] as const)
			expect(p115bPicture).toContain(
				`[&amp;_[data-money]_.${control}]:${eight}`,
			);
		expect(p115).toContain("decision 85");
		// The two pictures draw the same form twice: no id may repeat, or a label would point at the
		// other picture's field.
		const p115Ids = [...p115.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
		expect(p115Ids.length).toBeGreaterThan(2);
		expect(new Set(p115Ids).size).toBe(p115Ids.length);
		for (const pic of [p115aPicture, p115bPicture])
			for (const [, target] of pic.matchAll(/<label for="([^"]+)"/g))
				expect(pic).toContain(` id="${target}"`);

		// P116: the budget sheet with a second chip, the 3-month average (picked), or Last month alone.
		const p116 = section("p116-budget-average");
		const p116a = option(p116, "Option A · ");
		expect(picked(p116a)).toBe(false);
		const p116aPicture = picture(p116a);
		expect(p116aPicture).toContain("Last month: $");
		expect(p116aPicture).not.toContain("3-month average");
		const p116b = option(p116, "Option B · ");
		expect(picked(p116b) && recommended(p116b)).toBe(true);
		const p116bPicture = picture(p116b);
		expect(p116bPicture).toContain("Last month: $");
		expect(p116bPicture).toContain("3-month average: $650.00");
		expect(p116).toContain("decision 85");
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
