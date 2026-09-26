import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import design from "../DESIGN.md?raw";
import { designSystem } from "../src/routes/design-system";

const BASE = "http://tally.test";
const get = async (path: string) => {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;

/** Every component name in DESIGN.md's Components table ("Sidebar / BottomTabs" is two). */
function designComponents(): string[] {
	const table = design.split("## Components")[1]?.split("\n## ")[0] ?? "";
	return table
		.split("\n")
		.filter((line) => line.startsWith("| ") && !line.startsWith("| Component"))
		.flatMap((line) => (line.split("|")[1] ?? "").split(/[,/]/))
		.map((name) => name.trim())
		.filter(Boolean);
}

/** Each specimen's opening tag, which carries its tier and the components it shows. */
const specimens = (html: string) =>
	[...html.matchAll(/<section[^>]*data-ds-tier="[^"]*"[^>]*>/g)].map(
		(m) => m[0],
	);

describe("GET /design-system in the demo", () => {
	it("is the catalog, with the three tiers explained", async () => {
		const { res, html } = await get("/design-system");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Design system · Tally</title>");
		expect(html).toMatch(/<h1[^>]*>Design system<\/h1>/);
		for (const tier of ["Visual", "Interactive", "Flow"]) {
			expect(html).toContain(tier);
		}
	});

	it("shows every component in DESIGN.md's table", async () => {
		const { html } = await get("/design-system");
		const shown = specimens(html)
			.flatMap((tag) => tag.match(/data-ds-components="([^"]*)"/)?.[1] ?? "")
			.flatMap((names) => names.split(" "));
		const names = designComponents();
		expect(names.length).toBeGreaterThan(15);
		for (const name of names) expect(shown).toContain(name);
	});

	it("gives every specimen one tier, and makes Visual ones inert to htmx", async () => {
		const { html } = await get("/design-system");
		const tags = specimens(html);
		expect(tags.length).toBeGreaterThan(10);
		for (const tag of tags) {
			const tier = tag.match(/data-ds-tier="([^"]*)"/)?.[1];
			expect(["visual", "interactive", "flow"]).toContain(tier);
			// htmx 4's name for "ignore this subtree"; hx-disable now means something else.
			expect(tag.includes("hx-ignore")).toBe(tier === "visual");
		}
	});

	it("loads the catalog's own script, which fires sample toasts", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('src="/js/ds.js"');
		expect(html).toMatch(/data-ds-toast="success"/);
		expect(html).toMatch(/data-ds-toast="error"/);
	});

	it("blocks every form from submitting", async () => {
		const { res } = await get("/design-system");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("form-action 'none'");
		expect(csp).not.toContain("form-action 'self'");
	});

	it("shows the bottom sheet on a page of its own, over sample rows", async () => {
		const { res, html } = await get("/design-system/bottom-sheet");
		expect(res.status).toBe(200);
		expect(html).toContain('role="dialog"');
		expect(html).toContain('href="/design-system#bottom-sheet"');
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("form-action 'none'");
	});
});

describe("the catalog outside the demo", () => {
	it("doesn't exist in production", async () => {
		for (const path of ["/design-system", "/design-system/bottom-sheet"]) {
			const res = await designSystem.request(path, {}, notDemo);
			expect(res.status).toBe(404);
		}
	});
});

describe("app pages", () => {
	it("never load the catalog's script, and forms still post to this site", async () => {
		for (const path of ["/", "/transactions", "/settings", "/how-it-works"]) {
			const { res, html } = await get(path);
			expect(html).not.toContain("/js/ds.js");
			const csp = res.headers.get("content-security-policy") ?? "";
			expect(csp).toContain("form-action 'self'");
		}
	});
});
