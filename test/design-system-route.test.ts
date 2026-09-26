import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import design from "../DESIGN.md?raw";
import {
	ADJUST_ROWS,
	BAND,
	BUDGET_EXAMPLE,
	CATEGORIES_EXAMPLE,
	EXCLUSIONS_EXAMPLE,
	MONEY_STATES,
	PROGRESS_ROWS,
	TRANSACTION_ROWS,
	TRANSACTIONS_EXAMPLE,
} from "../src/design-system/mock";
import { USE_SPEC_PARTS } from "../src/design-system/specimen";
import { CATEGORY_COLORS } from "../src/design-system/tokens";
import { designSystem } from "../src/routes/design-system";
import { AdjustLink } from "../src/views/adjust-link";
import { Band } from "../src/views/band";
import { TallyMark, Wordmark } from "../src/views/brand";
import { CategoryIcon } from "../src/views/category";
import { Chip } from "../src/views/chip";
import {
	BudgetDiagram,
	CategoriesDiagram,
	ExclusionsDiagram,
	TransactionsDiagram,
} from "../src/views/how-diagrams";
import { HowLink } from "../src/views/how-link";
import { ICON_NAMES, Icon } from "../src/views/icons";
import { LedgerIllustration } from "../src/views/illustration";
import { MoneyInput } from "../src/views/money-input";
import { BottomTabs, Sidebar } from "../src/views/nav";
import { ProgressRow } from "../src/views/progress-row";
import { SystemDiagram } from "../src/views/system-diagram";
import { ThingsToTry } from "../src/views/things-to-try";
import { TransactionRow } from "../src/views/transaction-row";

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

	it("renders each component's own output, with the catalog's sample data", async () => {
		const { html } = await get("/design-system");
		const outputs = [
			Wordmark(),
			TallyMark({ class: "size-12" }),
			...ICON_NAMES.map((name) => Icon({ name })),
			...CATEGORY_COLORS.map((color) =>
				CategoryIcon({ icon: "groceries", color }),
			),
			LedgerIllustration(),
			Sidebar({}),
			BottomTabs({}),
			...PROGRESS_ROWS.map((s) => ProgressRow(s.props)),
			...ADJUST_ROWS.map((row) => ProgressRow(row)),
			AdjustLink({ adjusting: false, href: "#adjust-on" }),
			AdjustLink({ adjusting: true, href: "#adjust-off" }),
			...TRANSACTION_ROWS.map((s) => TransactionRow({ row: s.row })),
			Band({ href: BAND.href, children: BAND.text }),
			Chip({
				type: "checkbox",
				name: "ds-exclude",
				value: "1",
				children: "Exclude from budget",
			}),
			...MONEY_STATES.map((s) => MoneyInput(s.props)),
			ThingsToTry(),
			HowLink({ section: "budget", demo: true }),
			SystemDiagram(),
			BudgetDiagram(BUDGET_EXAMPLE),
			TransactionsDiagram(TRANSACTIONS_EXAMPLE),
			ExclusionsDiagram(EXCLUSIONS_EXAMPLE),
			CategoriesDiagram(CATEGORIES_EXAMPLE),
		];
		for (const output of outputs) {
			expect(html).toContain(await String(output ?? ""));
		}
		// FormField: its label points at the control, and its error is announced.
		expect(html).toContain('for="ds-name"');
		expect(html).toMatch(/<p id="ds-name-error-error" role="alert"/);
		// Layout: the toast region and the announcer are this page's own.
		expect(html).toContain('id="toasts"');
		expect(html).toContain('id="announcer"');
	});

	it("shows Adjust mode with its whole use spec, for sign-off (#94)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="adjust-mode"')[1]?.split("</section>")[0] ?? "";
		expect(section).toContain("How it&#39;s used");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		expect(section).toContain('aria-label="Kids is at $0"');
		// Adjust and Done move between the two states here; they don't leave for Home.
		expect(section).toContain('href="#adjust-on"');
		expect(section).toContain('href="#adjust-off"');
		expect(section).not.toMatch(/href="\/(\?adjust=1)?"/);
	});

	it("draws the bottom sheet on its own page", async () => {
		const { html } = await get("/design-system/bottom-sheet");
		expect(html).toMatch(
			/<section role="dialog" aria-labelledby="ds-sheet-title"/,
		);
		expect(html).toContain('id="ds-sheet-title"');
	});

	it("has no links that go nowhere: no specimen links back to the catalog itself", async () => {
		const { html } = await get("/design-system");
		expect(html).not.toMatch(/href="\/design-system#/);
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
