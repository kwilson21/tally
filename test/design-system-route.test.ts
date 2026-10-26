import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import design from "../DESIGN.md?raw";
import dsScript from "../public/js/ds.js?raw";
import { parseBudgetAmount } from "../src/budgets/amount";
import {
	ADJUST_ROWS,
	BAND,
	BANK_LINES,
	BUDGET_EXAMPLE,
	CATEGORIES_EXAMPLE,
	EXCLUSIONS_EXAMPLE,
	MONEY_STATES,
	PROGRESS_ROWS,
	TRANSACTION_ROWS,
	TRANSACTIONS_EXAMPLE,
	TRENDS_EARLY_INPUT,
	TRENDS_EMPTY_INPUT,
	TRENDS_INPUT,
	TRENDS_PART_INPUT,
} from "../src/design-system/mock";
import { USE_SPEC_PARTS } from "../src/design-system/specimen";
import { CATEGORY_COLORS } from "../src/design-system/tokens";
import { designSystem } from "../src/routes/design-system";
import { buildTrends } from "../src/trends";
import { AdjustLink } from "../src/views/adjust-link";
import { Band } from "../src/views/band";
import { TallyMark, Wordmark } from "../src/views/brand";
import { CategoryIcon } from "../src/views/category";
import { Chip } from "../src/views/chip";
import { EmptyState } from "../src/views/empty-state";
import { ErrorPage } from "../src/views/error-page";
import { FilterSelect } from "../src/views/filter-select";
import {
	BillsDiagram,
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
import { Switch } from "../src/views/switch";
import { SystemDiagram } from "../src/views/system-diagram";
import { ThingsToTry } from "../src/views/things-to-try";
import { TimeZoneRow } from "../src/views/time-zone-row";
import { TransactionRow } from "../src/views/transaction-row";
import { TrendsScreen } from "../src/views/trends";
import { ViewLinks } from "../src/views/view-links";

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

	it("shows the rows that open with their arrow, a held press, and Needs category in words (P118 A)", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('data-icon="chevron-right"');
		expect(html).toContain("bg-press");
		expect(html).toContain("Needs category\u00a0·\u00a0");
	});

	it("shows More's contents list in its three states, the demo's colophon and the family's version line (P122 A)", async () => {
		const { html } = await get("/design-system");
		const more =
			html.split('id="more-contents"')[1]?.split("</section>")[0] ?? "";
		expect(more).toContain("Accounts, 3 accounts");
		expect(more).toContain("Settings, 3 to check");
		expect(more).toContain("Needs attention");
		expect(more).toContain("None linked yet");
		expect(more).toContain("Tally demo · resets every night");
		expect(more).toContain("Tally v2026.10.12 · 9e5e14d");
	});

	it("shows the Your banks list in its three states, and the busy ring it draws (P140 A)", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('<section id="yourbanks"');
		expect(html).toContain("90 days in · 412");
		expect(html).toContain("Reading · 86 so far");
		expect(html).toContain("Paused · 86 so far");
		expect(html).toContain('<section id="busy-ring"');
	});

	it("draws the Your banks specimens without a poll, as their sentence says (decision 146)", async () => {
		const { html } = await get("/design-system");
		const section =
			html
				.split('<section id="yourbanks"')[1]
				?.split('<section id="busy-ring"')[0] ?? "";
		expect(section).toContain("this picture does not poll");
		// Each state is drawn with polls={false}: none carries the list's hx-get to /home/banks or its 5-second trigger.
		expect(section).not.toContain("/home/banks");
		expect(section).not.toContain('hx-trigger="every 5s"');
	});

	it("has one id=first-week on the page, the sidebar's group for a new family's first week (not Home's top)", async () => {
		const { html } = await get("/design-system");
		expect(html.split('id="first-week"').length - 1).toBe(1);
		expect(html).toContain(
			'<section id="first-week" aria-labelledby="first-week-title" class="mt-12">',
		);
		expect(html).toContain("A new family&#39;s first week</h2>");
		// Home's top draws its own section as setup-top, so the sidebar's #first-week lands on the group.
		expect(html).toContain('<section id="setup-top"');
	});

	it("its re-ask state shows step one as '2 banks, linked', since that state has two banks", async () => {
		const { html } = await get("/design-system");
		const state =
			html
				.split(
					"A bank linked during setup: a line under step one says Tally asks again about the questions",
				)[1]
				?.split("All five drawn, each with its day")[0] ?? "";
		expect(state).toContain("Tally asks again about pay, bills and budgets");
		expect(state).toContain("2 banks, linked");
		expect(state).not.toContain("Chase, linked");
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

	it("aims each Never suggest Remove at the section it sits in, never at #merchant-rules", async () => {
		const { html } = await get("/design-system");
		const standalone =
			html.split('id="never-suggest-list"')[1]?.split("</section>")[0] ?? "";
		const forms = standalone
			.split('action="/settings/never-suggest/remove"')
			.slice(1);
		expect(forms).toHaveLength(2);
		for (const form of forms) {
			expect(form.split(">")[0]).toContain('hx-target="#never-suggest-list"');
			expect(form.split(">")[0]).not.toContain("#merchant-rules");
		}
	});

	it("renders the savings goal sheet specimen and documents it", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('data-ds-components="SavingsGoalSheet"');
		expect(html).toContain(
			"Set aside from Safe to spend at the start of every month.",
		);
		expect(html).toContain("Save each month, from October on");
		expect(html).toContain(">Cancel</a>");
		expect(html).toContain(">Save</button>");
		expect(design).toMatch(/\| SavingsGoalSheet \|/);
	});

	it("documents the money input's use spec, and draws its empty box and its states", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="money-input"')[1]?.split("</section>")[0] ?? "";
		expect(section).toContain("How it&#39;s used");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		// The empty box shows the muted 0.00 placeholder (decision 117), and the dimmed chip is gone.
		expect(section).toContain('placeholder="0.00"');
		expect(section).toContain("Empty: a muted 0.00");
		expect(section).toContain("Equal to last month: its chip is ticked");
		expect(section).not.toContain("its chip is dimmed");
	});

	it("shows the budget sheet in its three states, each with its own ids, and documents it", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="budget-sheet"'));
		expect(tag).toContain('data-ds-tier="visual"');
		expect(tag).toContain(
			'data-ds-components="BudgetSheet MoneyInput TransactionsButton"',
		);
		const section =
			html.split('id="budget-sheet"')[1]?.split("</section>")[0] ?? "";
		// At rest: the spent line, the transactions link and the two chips.
		expect(section).toContain("$412.30 spent so far in October");
		expect(section).toContain("12 transactions");
		expect(section).toContain("Last month: $571.80");
		expect(section).toContain("3-month average: $602.45");
		// With cents: the amount reads $612.45 and Round to offers $613.
		expect(section).toContain('value="612.45"');
		expect(section).toContain("Round to $613");
		// A refused amount: the parser's own words, in role=alert, on a marked field.
		const refused = parseBudgetAmount("six hundred");
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected a refusal");
		expect(section).toMatch(
			new RegExp(`role="alert"[^>]*>${refused.error.replaceAll(".", "\\.")}<`),
		);
		// Three sheets on one page: no id is drawn twice.
		const ids = [...section.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
		expect(design).toMatch(/\| BudgetSheet \|/);
	});

	it("shows the split correction state and the cash amount error with Change the parts", async () => {
		const { html } = await get("/design-system");
		const split =
			html.split('id="split-form"')[1]?.split("</section>")[0] ?? "";
		expect(split).toContain(
			"The parts add up to $90.00. Change them to match $100.00.",
		);
		expect(split).toContain(
			'<span class="tabular-nums">$10.00</span> left to assign',
		);
		const cash = html.split('id="cash-form"')[1]?.split("</section>")[0] ?? "";
		expect(cash).toContain(
			"The parts add up to $90.00. Change them to match $100.00.",
		);
		expect(cash).toContain(">Change the parts</button>");
	});

	it("keeps catalog autofocus controls inside inert sample wrappers", async () => {
		const { html } = await get("/design-system");
		const savingsGoal = html.match(
			/<section[^>]*id="savings-goal-sheet"[\s\S]*?<\/section>/,
		)?.[0];
		expect(savingsGoal).toMatch(/<div[^>]*\binert(?:="")?[^>]*>/);

		const catalog = html.match(/<main[^>]*>[\s\S]*?<\/main>/)?.[0] ?? "";
		const stack: { tag: string; inert: boolean }[] = [];
		for (const token of catalog.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
			const tag = token[1]?.toLowerCase();
			if (!tag) continue;
			if (token[0].startsWith("</")) {
				stack.pop();
				continue;
			}
			if (/\bautofocus(?:="")?\b/i.test(token[0])) {
				expect(stack.some((ancestor) => ancestor.inert)).toBe(true);
			}
			if (!/\/>$/.test(token[0])) {
				stack.push({ tag, inert: /\binert(?:="")?\b/i.test(token[0]) });
			}
		}
	});

	it("shows the budgets step's nothing-to-ask state with its line above the ruled-off total (#590)", async () => {
		const { html } = await get("/design-system");
		// The state's own page: from its id to the no-categories state's (the line sits above the double rule).
		const section =
			html
				.split('id="setup-ruled-total-nothing-asked"')[1]
				?.split('id="setup-ruled-total-no-categories"')[0] ?? "";
		expect(section).toContain("Every category already has a budget.");
		expect(section).not.toContain("No categories to budget yet.");
		expect(
			section.indexOf("Every category already has a budget."),
		).toBeLessThan(section.indexOf("border-double"));
	});

	it("shows the budgets step's no-categories state with its own line above the ruled-off total (#692)", async () => {
		const { html } = await get("/design-system");
		// The state's own page: from its id to the accounts group's (the group closes the first-week section).
		const section =
			html
				.split('id="setup-ruled-total-no-categories"')[1]
				?.split('id="accounts"')[0] ?? "";
		expect(section).toContain("No categories to budget yet.");
		expect(section).not.toContain("Every category already has a budget.");
		expect(section.indexOf("No categories to budget yet.")).toBeLessThan(
			section.indexOf("border-double"),
		);
	});

	it("draws no old first page ids, and setup's ruled-off total holds Safe to spend and Go to Home with no nothing-to-ask line (#773)", async () => {
		const { html } = await get("/design-system");
		expect(html).not.toContain('id="first-page"');
		expect(html).not.toContain('id="first-page-questions"');
		expect(html).not.toContain('id="first-page-budgets"');
		const done =
			html
				.split('id="setup-ruled-total-done"')[1]
				?.split('id="setup-ruled-total-nothing-asked"')[0] ?? "";
		expect(done).toContain("Safe to spend");
		expect(done).toContain("border-double");
		expect(done).toContain("Go to Home");
		expect(done).not.toContain("Every category already has a budget.");
		expect(done).not.toContain("No categories to budget yet.");
	});

	it("keeps every sheet and backdrop on the catalog inside a contained frame, so none covers the page (#610)", async () => {
		const { html } = await get("/design-system");
		const main = html.match(/<main[^>]*>[\s\S]*?<\/main>/)?.[0] ?? "";
		const voids = new Set([
			"area",
			"base",
			"br",
			"col",
			"embed",
			"hr",
			"img",
			"input",
			"link",
			"meta",
			"source",
			"track",
			"wbr",
		]);
		// Each open element, and whether it is a sheet frame: a fixed sheet is contained by an ancestor frame.
		const open: { frame: boolean }[] = [];
		const markers: boolean[] = [];
		// Each fixed piece pinned to the screen's bottom or whole edge, by its classes: a backdrop or a sheet, whatever its markers.
		const fixedInFrame: boolean[] = [];
		let frames = 0;
		for (const token of main.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
			const tag = token[1]?.toLowerCase() ?? "";
			if (token[0].startsWith("</")) {
				if (!voids.has(tag)) open.pop();
				continue;
			}
			const frame = /\sdata-sheet-frame(?:="")?[\s>]/.test(token[0]);
			if (frame) {
				frames += 1;
				expect(token[0]).toContain("contain-paint");
			}
			// A sheet's section (data-sheet) and its backdrop (data-sheet-close) are the fixed pieces.
			if (/\sdata-sheet(?:-close)?(?:="")?[\s>]/.test(token[0])) {
				markers.push(open.some((ancestor) => ancestor.frame));
			}
			const classes = (token[0].match(/\sclass="([^"]*)"/)?.[1] ?? "").split(
				/\s+/,
			);
			if (
				classes.includes("fixed") &&
				(classes.includes("inset-0") || classes.includes("bottom-0"))
			) {
				fixedInFrame.push(open.some((ancestor) => ancestor.frame));
			}
			if (!voids.has(tag) && !/\/>$/.test(token[0])) {
				open.push({ frame });
			}
		}
		// The three planned-expense states: a sheet and a backdrop each, every one inside its frame. The class check
		// comes first, so a backdrop or sheet drawn without its marker still fails here.
		expect(fixedInFrame).toEqual([true, true, true, true, true, true]);
		expect(frames).toBe(3);
		expect(markers).toEqual([true, true, true, true, true, true]);
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
			ErrorPage({ kind: "404" }),
			ErrorPage({ kind: "500", retryHref: "#error-pages" }),
			ErrorPage({ kind: "500" }),
			Sidebar({}),
			BottomTabs({}),
			...PROGRESS_ROWS.map((s) =>
				ProgressRow({ ...s.props, href: "#progress-row" }),
			),
			...ADJUST_ROWS.map((row) => ProgressRow(row)),
			AdjustLink({ adjusting: false, href: "#adjust-on" }),
			AdjustLink({ adjusting: true, href: "#adjust-off" }),
			...TRANSACTION_ROWS.map((s) =>
				TransactionRow({ row: s.row, href: "#transaction-row" }),
			),
			EmptyState({
				kind: "search",
				sentence: "No transactions match these filters.",
				hint: "Try a wider month, or clear the search.",
				action: { href: "/transactions", label: "Clear filters" },
			}),
			Band({ href: BAND.href, children: BAND.text }),
			Chip({
				type: "checkbox",
				name: "ds-exclude",
				value: "1",
				children: "Exclude from budget",
			}),
			FilterSelect({
				id: "ds-filter-account",
				name: "ds-account",
				label: "Account",
				options: [
					{ value: "", label: "All accounts" },
					{ value: 3, label: "Chase Card ••9921" },
					{ value: 5, label: "Old Savings ••3340 · Disconnected" },
					{ value: 4, label: "Cash" },
				],
				selected: null,
			}),
			Switch({
				id: "ds-switch-on",
				name: "ds-switch-on",
				label: "Categories and exclusions",
				hint: "Picks categories, and leaves out transfers and reimbursements.",
				checked: true,
			}),
			TimeZoneRow({
				id: "ds-zone-closed",
				zone: "America/New_York",
				action: "#",
				back: "#",
				backSwap: "#",
			}),
			TimeZoneRow({
				id: "ds-zone-error",
				zone: "America/Chicago",
				error: "Choose a time zone from the list.",
				action: "#",
				back: "#",
				backSwap: "#",
			}),
			...MONEY_STATES.map((s) => MoneyInput(s.props)),
			ThingsToTry(),
			HowLink({ section: "budget" }),
			SystemDiagram(),
			BudgetDiagram({ ...BUDGET_EXAMPLE, id: "budget-diagram-plain" }),
			BillsDiagram({
				amount: "$142.00",
				due: "Sep 21",
				paid: "Sep 24",
				windowDays: 5,
				tolerance: "10%",
			}),
			TransactionsDiagram(TRANSACTIONS_EXAMPLE),
			ExclusionsDiagram(EXCLUSIONS_EXAMPLE),
			CategoriesDiagram(CATEGORIES_EXAMPLE),
			// Trends' parts, drawn as the page draws them: full, one month in, and empty.
			TrendsScreen({ page: buildTrends(TRENDS_INPUT) }),
			TrendsScreen({
				id: "ds-screen-part",
				page: buildTrends(TRENDS_PART_INPUT),
			}),
			TrendsScreen({
				id: "ds-screen-early",
				page: buildTrends(TRENDS_EARLY_INPUT),
			}),
			TrendsScreen({ page: buildTrends(TRENDS_EMPTY_INPUT) }),
		];
		for (const output of outputs) {
			expect(html).toContain(await String(output ?? ""));
		}
		expect(html).toContain('data-ds-components="MerchantRules"');
		expect(html).toContain("Always Groceries · 23 transactions");
		// FormField: its label points at the control, and its error is announced.
		expect(html).toContain('for="ds-name"');
		expect(html).toMatch(/<p id="ds-name-error-error" role="alert"/);
		// Layout: the toast region and the announcer are this page's own.
		expect(html).toContain('id="toasts"');
		expect(html).toContain('id="announcer"');
	});

	it("gives the three scrollable MonthEnd specimens unique targets across the catalog", async () => {
		const { html } = await get("/design-system");
		const ids = [...html.matchAll(/id="([^"]*-chart-end)"/g)].map(
			(match) => match[1],
		);
		const links = [...html.matchAll(/href="#([^"]*-chart-end)"/g)].map(
			(match) => match[1],
		);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(ids.length);
		expect(links).toEqual(ids);
		expect(html).toContain("bg-ink text-lg text-paper shadow-swipe-cue");
		expect(html).toContain("month-end-swipe-arrow-left text-accent");
		expect(html).toContain(
			"The twelve-category ink arrow and terracotta cue under prefers-reduced-motion: arrows rest",
		);
	});

	it("describes every Accounts action's states, and shows Sync now as the app does", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="accounts-screen"')[1]?.split("</section>")[0] ?? "";
		for (const words of [
			"while pending it is disabled and says Fixing…, success shows a Fixed bank toast",
			"while a request is pending the button is disabled and says Linking…, success shows a Linked bank toast",
			"says Syncing…",
		]) {
			expect(section).toContain(words);
		}
		// The app's id, once on the page (the phone picture), not in both pictures.
		expect(html.match(/id="sync-now"/g)).toHaveLength(1);
		expect(section).toContain("Syncing…");
		expect(design).toMatch(/\| SyncNow \|.*Syncing…/);
	});

	it("shows the stale-bank line in each of its states, with its whole use spec, as the family app draws it", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="bank-behind"'));
		expect(tag).toContain('data-ds-tier="visual"');
		expect(tag).toContain('data-ds-components="BankBehind"');
		const section =
			html.split('id="bank-behind"')[1]?.split("</section>")[0] ?? "";
		// Its words come from the real function, so the catalog can't drift from Home.
		expect(Object.values(BANK_LINES)).toHaveLength(3);
		for (const words of Object.values(BANK_LINES))
			for (const word of words)
				expect(section).toContain(word.replaceAll("'", "&#39;"));
		expect(BANK_LINES.stale[0]).toContain("stopped updating");
		expect(BANK_LINES.signIn[0]).toContain("needs signing in");
		expect(BANK_LINES.several[0]).toContain("Citi stopped updating Sep 20");
		expect(BANK_LINES.several[1]).toContain("Chase needs signing in");
		// Each picture is described in words, the bank's words and its link included.
		const labels = [...section.matchAll(/role="img" aria-label="([^"]*)"/g)]
			.map((m) => m[1] ?? "")
			.filter((l) => l.includes("Home"));
		expect(labels).toHaveLength(3);
		for (const label of labels.slice(-3)) {
			expect(label).toContain("Safe to spend $283");
			expect(label).toContain("Fix");
		}
		// The 44px link, drawn in a family app's phone (no demo banner) beside Home's real top.
		expect(section).toContain("Fix");
		expect(section).toContain("min-h-11");
		expect(section).toContain("Safe to spend");
		expect(section).not.toContain("Demo data. Nothing here is real.");
		expect(section).toContain("How it&#39;s used");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		// DESIGN.md says where it sits.
		expect(design).toMatch(
			/\| BankBehind \|[^\n]*Fix link to Accounts[^\n]*before the forecast/,
		);
	});

	it("shows the forecast and its before-day-7 daily amount in the catalog", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="home-top"')[1]?.split("</section>")[0] ?? "";
		expect(section).toContain('aria-label="Spending in Oct');
		expect(section).toContain("About $15.03 a day for the 27 days left.");
	});

	it("shows the Switch on, off and without a muted line, with its whole use spec, as the AI suggestions group uses it (decision 73)", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="switch"'));
		expect(tag).toContain('data-ds-tier="interactive"');
		expect(tag).toContain('data-ds-components="Switch"');
		const section = html.split('id="switch"')[1]?.split("</section>")[0] ?? "";
		const inputs = [...section.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map(
			(m) => m[0],
		);
		// Three live ones, and two greyed out (P86 A): one saved On and one saved Off.
		expect(inputs).toHaveLength(6);
		const on = (input: string) => /\schecked(\s|>|=)/.test(input);
		const greyed = (input: string) => /\sdisabled(\s|>|=)/.test(input);
		expect(inputs.filter((i) => !greyed(i))).toHaveLength(4);
		expect(inputs.filter(greyed)).toHaveLength(2);
		expect(inputs.filter((i) => greyed(i) && on(i))).toHaveLength(1);
		expect(inputs.filter(on)).toHaveLength(4);
		expect(inputs.filter((i) => !on(i))).toHaveLength(2);
		// The real checkboxes are the only controls here: nothing posts from the catalog.
		expect(section).not.toContain("<form");
		expect(section).not.toContain("<button");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		// DESIGN.md says what it is and that it works without a script.
		expect(design).toMatch(
			/\| Switch \|[^\n]*"On" or "Off" in words[^\n]*without JavaScript/,
		);
		// Its name for the AI never says Jev, since this is the family's screen too.
		expect(section).not.toMatch(/jev/i);
		// It lists only the AI switches that have a feature behind them, as Settings does.
		expect(design).toMatch(
			/Suggest store names; Categories and exclusions; Income; Sort new transactions as they arrive/,
		);
		expect(section).not.toContain("Merchant names");
		// The greyed ones say what they need, so the greying never rests on color alone.
		expect(
			section.match(/Needs Categories and exclusions or Income on\./g),
		).toHaveLength(2);
		expect(design).toMatch(/\| Switch \|[^\n]*Greyed out[^\n]*saved On or Off/);
	});

	it("shows NameChoices with a guess chosen and not, an error, and its whole use spec (P29 A, P87 B)", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="name-choices"'));
		expect(tag).toContain('data-ds-tier="interactive"');
		expect(tag).toContain('data-ds-components="NameChoices RenameChoices"');
		const section =
			html.split('id="name-choices"')[1]?.split("</section>")[0] ?? "";
		// Each state its own radio group (and each Rename list its own), and nothing posts from the catalog.
		const radios = [...section.matchAll(/<input[^>]*type="radio"[^>]*>/g)];
		expect(radios.length).toBeGreaterThanOrEqual(8);
		const groups = [
			...section.matchAll(/<input[^>]*type="radio"[^>]*name="([^"]+)"/g),
		].map((m) => m[1]);
		// The Exclude-ticked state adds two: its Name row and its Rename list (#428).
		expect(new Set(groups).size).toBe(15);
		const chosen = radios.filter(
			(m) => /\schecked(\s|>|=)/.test(m[0]) && /name="ds-names-/.test(m[0]),
		);
		expect(chosen).toHaveLength(1);
		expect(section).not.toContain("<form");
		expect(section).not.toContain("<button");
		// Where the guesses came from, under them: the icon, "Tally's guess" and a Why?.
		expect(section).toContain("Tally&#39;s guess");
		expect(section).toContain('href="/how-it-works#names"');
		// A name the bank sent says so quietly: muted words, no icon, no Why? (P87 B).
		expect(section).toMatch(
			/<p id="ds-names-bank-source-0" class="text-sm text-muted">From your bank<\/p>/,
		);
		expect(section).toContain('role="alert"');
		expect(section).toContain("Type a name here, or pick one above.");
		// The specimen's sentence describes the Name row as one ticked list, and the Rename list it opens (decision 101).
		expect(section).toContain("one ticked list, one choice per line");
		expect(section).toContain("Ticking a name shows the Rename list");
		// The Rename list's words (decision 101), in its own specimens.
		expect(section).toContain("This one only");
		expect(section).toContain("Both from Amazon, this one too");
		expect(section).toContain("Dog bed is replaced.");
		expect(section).toMatch(/id="ds-names-error-own"[^>]*value=""/);
		expect(section).not.toMatch(/name="ds-names-error"[^>]*checked/);
		expect(html).toContain('name="ds-names-narrow"');
		expect(html).toContain("320px");
		expect(html).toContain(
			"A very long guessed store name for the neighborhood market",
		);
		expect(html).toContain(
			"A very long tidied name the bank sent for a neighborhood market",
		);
		expect(html).toContain(
			"https://example.com/this-is-a-long-unbroken-name-for-the-bank",
		);
		expect(section).toContain('value="store"');
		expect(section).toContain("wrap-anywhere");
		expect(section).toContain("Your own name");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		// Never the name of the AI behind it.
		expect(section).not.toMatch(/jev|workers ai/i);
		expect(design).toMatch(
			/\| NameChoices \|[^\n]*Tally's guess[^\n]*Type your own[^\n]*without JavaScript/,
		);
		expect(design).toMatch(/\| RenameChoices \|[^\n]*This one only[^\n]*/);
	});

	it("catalogs transaction detail rows and the household people list before app use (P89 A)", async () => {
		const { html } = await get("/design-system");
		const detail =
			html.split('id="detail-row"')[1]?.split("</section>")[0] ?? "";
		const people = html.split('id="household-people"')[1] ?? "";
		expect(detail).toContain('data-ds-components="DetailRow"');
		expect(detail).toContain("What it was");
		expect(detail).toContain("Tally&#39;s guess");
		expect(detail).toContain("decoration-dashed");
		// An empty Kind shows Add with no source line, in the catalog and in DESIGN.md (#688).
		expect(detail).toContain('id="ds-detail-empty-kind"');
		expect(detail).toContain("An empty detail has no source line.");
		expect(people).toContain('data-ds-components="HouseholdPeople"');
		expect(html).toContain("Add a person");
		expect(html).toContain("Everyone");
		expect(design).toMatch(
			/\| DetailRow \|[^\n]*Name, What it was, Kind and For/,
		);
		expect(design).toMatch(
			/\| DetailRow \|[^\n]*An empty detail has no source line\./,
		);
		expect(design).toMatch(
			/Transaction details \(P89 A[^\n]*An empty detail has no source line\./,
		);
		expect(design).toMatch(/\| HouseholdPeople \|[^\n]*Everyone/);
	});

	it("shows ViewLinks with each view current, as the demo's Transactions draws it, with its whole use spec (P44 A)", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="view-links"'));
		// Plain links that work in the demo and in development, so there is nothing to fake.
		expect(tag).toContain('data-ds-tier="visual"');
		expect(tag).toContain('data-ds-components="ViewLinks"');
		const section =
			html.split('id="view-links"')[1]?.split("</section>")[0] ?? "";
		// The real component, once for each view, so the two looks sit side by side.
		for (const current of ["made", "bank"] as const)
			expect(section).toContain(
				String(
					ViewLinks({
						id: `ds-view-${current}`,
						current,
						madeHref: "/transactions",
						bankHref: "/transactions?raw=1",
					}),
				),
			);
		expect(section.match(/<nav [^>]*aria-label="View"/g)).toHaveLength(3);
		expect(section.match(/aria-current="page"/g)).toHaveLength(3);
		// And the narrowest phone, where the links wrap.
		expect(section).toContain("w-[320px]");
		expect(section).not.toContain("<form");
		expect(section).not.toContain("<button");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		expect(section).not.toMatch(/jev/i);
		// DESIGN.md says what it is, where it shows and that it needs no script.
		expect(design).toMatch(
			/\| ViewLinks \|[^\n]*With Tally · Without Tally[^\n]*aria-current[^\n]*demo only[^\n]*no JavaScript/,
		);
	});

	it("says a payment linked to a bill or a planned expense counts whatever its exclusion, in TransactionsButton's edges (#202)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="transactions-button"')[1]?.split("</section>")[0] ?? "";
		expect(section).toContain(
			"a payment linked to a bill or a planned expense counts whatever its exclusion.",
		);
		expect(section).not.toContain(
			"a payment linked to a bill counts whatever its exclusion.",
		);
	});

	it.each([
		"not-budgeted-row",
		"transactions-button",
		"file-field",
		"apple-card-sheet",
		"apple-card-remove",
	])(
		"gives %s its whole use spec, as a visual component (DESIGN.md section 3)",
		async (id) => {
			const { html } = await get("/design-system");
			const tag = specimens(html).find((t) => t.includes(`id="${id}"`));
			expect(tag).toContain('data-ds-tier="visual"');
			const section = html.split(`id="${id}"`)[1]?.split("</section>")[0] ?? "";
			for (const [, label] of USE_SPEC_PARTS) {
				expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
			}
		},
	);

	it.each([
		"setup-welcome",
		"setup-reading",
		"setup-pay",
		"setup-bills",
		"setup-budgets",
		"setup-one-budget",
		"setup-savings",
		"setup-ruled-total",
	])(
		"gives %s its whole use spec, as a visual component, from its own section (decision 148, DESIGN.md section 3)",
		async (id) => {
			const { html } = await get("/design-system");
			const tag = specimens(html).find((t) => t.includes(`id="${id}"`));
			expect(tag).toContain('data-ds-tier="visual"');
			// The section draws its own Your banks list and frame, so it is sliced to the next specimen, not to its </section>.
			const section =
				html.split(`id="${id}"`)[1]?.split(/<section[^>]*data-ds-tier=/)[0] ??
				"";
			for (const [, label] of USE_SPEC_PARTS) {
				expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
			}
		},
	);

	it("draws the reading screen's words in its states, and no presence check-in, since a drawing fires nothing (decision 146)", async () => {
		const { html } = await get("/design-system");
		const section =
			html
				.split('id="setup-reading"')[1]
				?.split(/<section[^>]*data-ds-tier=/)[0] ?? "";
		for (const words of [
			"at about 5 AM",
			"at about 10 AM",
			"Sorting your last 90 days: 318 of 412 done.",
			"Sorting is taking longer than usual: 900 of 1,500.",
			"Link another bank",
		]) {
			expect(section).toContain(words);
		}
		expect(section).not.toContain('hx-post="/home/seen"');
	});

	it("gives each AppleCardSheet state its own ids, so each label and description reads its own field (#766)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="apple-card-sheet"')[1]?.split("</section>")[0] ?? "";
		const ids = [...section.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(10);
		expect(new Set(ids).size).toBe(ids.length);
		// Every id a label or description names is drawn once on the page, so none points at another state's field.
		const refs = [
			...section.matchAll(
				/(?:aria-labelledby|aria-describedby|\bfor)="([^"]+)"/g,
			),
		].flatMap((m) => (m[1] ?? "").split(" "));
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs)
			expect(html.split(`id="${ref}"`).length - 1).toBe(1);
	});

	it("draws the before-first-upload Apple Card state as Accounts does: Add Apple Card beside Link a bank, and no group yet (#766)", async () => {
		const { html } = await get("/design-system");
		const state =
			html
				.split("Before the first upload: no card yet")[1]
				?.split("No balance yet")[0] ?? "";
		expect(state).toContain("Link a bank");
		expect(state).toContain("Add Apple Card");
		expect(state).toContain("data-link-bank-error");
		expect(state).not.toContain("data-apple-card");
		expect(state).not.toContain("Upload a file");
	});

	it("draws the SuggestionCard specimen's Yes full width, with No under it, never beside it (P42 A)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="suggestion-cards"')[1]?.split("</section>")[0] ?? "";
		// Each card's answers sit in the form (or the div inside it) that holds its Yes: none may be a two-column grid.
		const answered = section
			.split("<form")
			.slice(1)
			.filter((form) => form.includes('name="answer" value="yes"'));
		expect(answered.length).toBeGreaterThanOrEqual(3);
		for (const form of answered)
			expect(form.split('name="answer" value="yes"')[0]).not.toContain(
				"grid-cols-2",
			);
	});

	it("counts the three other merchants of the Organize card's fixture in both states, as the fixture's four merchants do", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="suggestion-card"')[1]?.split("</section>")[0] ?? "";
		const sentence =
			"Tally suggested a new category for this and 3 more: Pet Care";
		expect(section.split(sentence).length - 1).toBe(2);
		expect(section).not.toContain("and 2 more");
	});

	it("shows a guessed name in TransactionRow with the sparkles icon, dashed, and says so in DESIGN.md", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="transaction-row"')[1]?.split("</section>")[0] ?? "";
		expect(section).toContain("Tally&#39;s guess: ");
		// Two guessed names and one the bank sent: all dashed, only the guesses with the icon.
		expect(section.match(/decoration-dashed/g)).toHaveLength(4);
		expect(section.match(/Tally&#39;s guess: /g)).toHaveLength(3);
		expect(section).toContain("Dashed names are suggestions.");
		expect(section.match(/From your bank: /g)).toHaveLength(1);
		expect(design).toMatch(
			/\| TransactionRow \|[^\n]*sparkles icon[^\n]*dashed underline/,
		);
	});

	it("names the bill a bank change left unpaid in TransactionRow's sentence, as DESIGN.md says (#443)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="transaction-row"')[1]?.split("</section>")[0] ?? "";
		// The specimen's own sentence, the words the owner reads above the states.
		const sentence =
			section.match(
				/<p class="mt-1 max-w-prose text-muted">([^<]*)<\/p>/,
			)?.[1] ?? "";
		expect(sentence).toContain(
			"“The bank changed this from $187.42, so its split was removed.”",
		);
		expect(sentence).toContain(
			"“The Costco membership bill for 2026 is no longer paid.”",
		);
		expect(sentence).toContain("“2 bills are no longer paid.”");
		expect(sentence).toContain(
			"“for September 2026”, “for Q3 2026” or “for Sep 14, 2026”",
		);
		expect(sentence).toContain("a bill paid again drops out");
		expect(design).toMatch(
			/\| TransactionRow \|[^\n]*The Costco membership bill for 2026 is no longer paid\./,
		);
	});

	it("shows a payment linked to a planned expense in TransactionRow as DESIGN.md's example, 'Auto · paid Car registration'", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="transaction-row"')[1]?.split("</section>")[0] ?? "";
		expect(section).toContain("Auto · paid Car registration");
	});

	it("shows a paid plan's sheet with the day the app shows, 'Oct 3', not the stored date (#627)", async () => {
		const { html } = await get("/design-system");
		// Up to the next specimen: the sheets inside it close with their own </section>.
		const section =
			html.split('id="planned-expense"')[1]?.split('id="bill-finding"')[0] ??
			"";
		// The paid sheet's drawing runs up to the next state, Delete asks first.
		const start = section.search(
			/A plan(&#39;|')s sheet once it(&#39;|')s paid, with Unlink/,
		);
		expect(start).toBeGreaterThan(-1);
		const paid = section.slice(
			start,
			section.indexOf("Delete asks first", start),
		);
		expect(paid).toContain("DMV · Oct 3 · $180.00");
		expect(paid).not.toContain("2026-10-03");
	});

	it("says which refund and bill a TransactionRow caption keeps, in its sentence and DESIGN.md (#382)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="transaction-row"')[1]?.split("</section>")[0] ?? "";
		const sentence =
			section.match(
				/<p class="mt-1 max-w-prose text-muted">([^<]*)<\/p>/,
			)?.[1] ?? "";
		expect(sentence).toContain(
			"then “$X refunded” and “paid [bill] bill” where they apply",
		);
		expect(sentence).toContain("adds “paid [bill] bill” when it paid one");
		expect(design).toMatch(
			/\| TransactionRow \|[^\n]*then "\$X refunded" and "paid \[bill\] bill" where they apply/,
		);
		expect(design).toMatch(
			/\| TransactionRow \|[^\n]*adds "paid \[bill\] bill" when it paid one/,
		);
	});

	it("shows the Chip disabled, as the edit panel draws it while a refund is linked to a purchase, and DESIGN.md says how it looks", async () => {
		const { html } = await get("/design-system");
		const section = html.split('id="chip"')[1]?.split("</section>")[0] ?? "";
		const disabled = section.match(/<fieldset[^>]*disabled[^>]*>[\s\S]*$/)?.[0];
		expect(disabled).toContain('type="radio"');
		// Faded, with a not-allowed cursor, as Button fades: it must not look clickable.
		expect(disabled).toContain("has-[:disabled]:opacity-40");
		expect(disabled).toContain("has-[:disabled]:cursor-not-allowed");
		expect(design).toMatch(
			/\| Chip \|[^\n]*disabled fieldset[^\n]*40%[^\n]*not-allowed cursor/,
		);
	});

	it("shows the FilterSelect as Transactions' filter bar draws it, on a phone too, with its whole use spec", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="filter-select"'));
		expect(tag).toContain('data-ds-tier="interactive"');
		expect(tag).toContain('data-ds-components="FilterSelect"');
		const section =
			html.split('id="filter-select"')[1]?.split("</section>")[0] ?? "";
		// The page's four choices, each a real select named by a label only a screen reader hears.
		const ids = [...section.matchAll(/<select id="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThanOrEqual(5);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(section).toMatch(
				new RegExp(`<label for="${id}" class="sr-only">[^<]+</label>`),
			);
		}
		for (const label of ["Month", "Category", "Account", "Show"]) {
			expect(section).toContain(`class="sr-only">${label}</label>`);
		}
		// A disconnected bank's account, and a long name on a 320px phone.
		expect(section).toContain("· Disconnected");
		expect(section).toContain("w-[320px]");
		// Nothing posts from the catalog: the selects are the only controls.
		expect(section).not.toContain("<form");
		expect(section).not.toContain("<button");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		expect(section).not.toMatch(/jev/i);
		// DESIGN.md says what it is and what it names.
		expect(design).toMatch(
			/\| FilterSelect \|[^\n]*pill[^\n]*Month, Category, Account and Show/,
		);
	});

	it("lists the shared Maybe parts in the Rows catalog (P32 A)", async () => {
		const { html } = await get("/design-system");
		const tag =
			specimens(html).find((t) => t.includes('id="maybe-category"')) ?? "";
		expect(tag).toContain('data-ds-tier="visual"');
		expect(tag).toContain(
			'data-ds-components="MaybeCategory MaybeIncome SuggestedCategoryChip Chip WhyLink"',
		);
		expect(html).toContain("Maybe new: Pet Care");
		expect(html).toContain("Tally&#39;s guess");
		const specimen =
			html.split('id="maybe-category"')[1]?.split("</section>")[0] ?? "";
		expect(specimen).toMatch(/<div class="flex flex-wrap items-start gap-3">/);
		expect(specimen).toMatch(
			/<p id="ds-income-guess-line" class="flex flex-wrap items-center gap-x-2 text-sm text-muted">Tally&#39;s guess · 71% sure<a href="\/how-it-works#categorization"[^>]*>Why\?<\/a><\/p>/,
		);
	});

	it("puts the CategoryGrid specimen's Tally's guess chip in the grid's radio group, so only one choice can be checked (#687)", async () => {
		const { html } = await get("/design-system");
		const specimen =
			html.split('id="category-grid"')[1]?.split("</section>")[0] ?? "";
		const radios = [...specimen.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(
			(m) => m[0],
		);
		const nameOf = (input: string) => input.match(/ name="([^"]+)"/)?.[1];
		const guess = radios.find((input) =>
			input.includes('aria-describedby="category-suggestion-confidence-3-3"'),
		);
		// The chip and the grid's choices share one group, named for the grid, and no other specimen uses that name.
		const group = nameOf(guess ?? "");
		expect(group).toBe("ds-grid-guess");
		const inGroup = radios.filter((input) => nameOf(input) === group);
		expect(inGroup.length).toBeGreaterThan(2);
		expect(html.split(`name="${group}"`)).toHaveLength(inGroup.length + 1);
		// With Groceries chosen, that group has exactly one checked choice.
		expect(
			inGroup.filter((input) => /\schecked(\s|>|=)/.test(input)),
		).toHaveLength(1);
	});

	it("drops the How this works sentence from DESIGN.md's edit-panel layout, since decision 111 took that link off the panel (#687)", () => {
		const bullet =
			design
				.split("\n")
				.find((line) =>
					line.startsWith("- Edit panel layout (owner's pick C, #27):"),
				) ?? "";
		expect(bullet).toMatch(/\(spec §8\.5\)\.$/);
		expect(bullet).not.toContain("How this works");
	});

	it("shows the time zone row closed, open, with an error and on a narrow phone, with its whole use spec, as Settings' Household group draws it (P35 A)", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="time-zone-row"'));
		// Visual: a form here posts nowhere, and the specimen is inert to htmx.
		expect(tag).toContain('data-ds-tier="visual"');
		expect(tag).toContain('data-ds-components="TimeZoneRow"');
		expect(tag).toContain("hx-ignore");
		const section =
			html.split('id="time-zone-row"')[1]?.split("</section>")[0] ?? "";
		// Five rows, each in an inert box so nothing in them can be tapped or can take focus.
		expect(section.match(/<details/g)).toHaveLength(5);
		expect(section.match(/<div inert/g)).toHaveLength(5);
		// Closed, open (the chevron's turned state is the open attribute), and the error one open too.
		expect(
			[...section.matchAll(/<details[^>]*>/g)].map((m) =>
				/\sopen(\s|>|=)/.test(m[0]),
			),
		).toEqual([false, true, true, false, false]);
		// The saved row held still: its tick in the chevron's place (P119 A, #71).
		expect(section.match(/row-saved-held/g)).toHaveLength(1);
		expect(section).toContain("Eastern");
		expect(section).toContain("Puerto Rico");
		expect(section).toMatch(
			/role="alert"[^>]*>Choose a time zone from the list\./,
		);
		expect(section).toContain("Decides when a new month starts");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		expect(section).not.toMatch(/jev/i);
		// DESIGN.md says what it is, and that it works without a script.
		expect(design).toMatch(
			/\| TimeZoneRow \|[^\n]*"Time zone"[^\n]*works without JavaScript/,
		);
	});

	it("shows Settings' category row closed, open at both ends of the list, with a name error, and Add category open, all inert (as Settings draws it)", async () => {
		const { html } = await get("/design-system");
		const tag = specimens(html).find((t) => t.includes('id="category-row"'));
		// Visual: a form here posts nowhere, and the specimen is inert to htmx.
		expect(tag).toContain('data-ds-tier="visual"');
		expect(tag).toContain(
			'data-ds-components="CategoryRow AddCategoryRow TextInput Button"',
		);
		expect(tag).toContain("hx-ignore");
		const section =
			html.split('id="category-row"')[1]?.split("</section>")[0] ?? "";
		// One inert box per state: two closed rows, then the first and last rows open, the name error, Add category, and the saved row held still (P119 A).
		expect(section.match(/<div inert/g)).toHaveLength(6);
		expect(
			[...section.matchAll(/<details[^>]*>/g)].map((m) =>
				/\sopen(\s|>|=)/.test(m[0]),
			),
		).toEqual([false, false, true, true, true, true, false]);
		// The saved row held still: its tick in the chevron's place (P119 A, #71).
		expect(section.match(/row-saved-held/g)).toHaveLength(1);
		expect(section).toContain('class="saved-tick ');
		// Closed: a budget, then No budget.
		const closed = section.split('id="cat-21-form"')[0] ?? "";
		expect(closed).toContain("$700");
		expect(closed).toContain("No budget");
		// The first row open: Move up is absent, Move down is there.
		const first =
			section.split('id="cat-21-form"')[1]?.split('id="cat-31-form"')[0] ?? "";
		expect(first).not.toContain("Move up");
		expect(first).toContain("Move down");
		// The last row open: Move down is absent, Move up is there.
		const last =
			section.split('id="cat-31-form"')[1]?.split('id="cat-41-form"')[0] ?? "";
		expect(last).toContain("Move up");
		expect(last).not.toContain("Move down");
		// The name error, in role=alert, with the server's words for an empty name.
		const error =
			section
				.split('id="cat-41-form"')[1]
				?.split('id="new-category-form"')[0] ?? "";
		expect(error).toMatch(/role="alert"[^>]*>Give the category a name\.<\/p>/);
		// Add category, open, with its own Name field and button.
		const add = section.split('id="new-category-form"')[1] ?? "";
		expect(add).toContain('id="new-name"');
		expect(add).toContain(">Add category</span>");
		// DESIGN.md says what it is, right after the Bank sign-in emails row.
		expect(design).toMatch(
			/\| BankSignInEmails \|[^\n]*\n\| CategoryRow, AddCategoryRow \|/,
		);
	});

	it("shows the price-changed offer on the bill's row and page, with its whole use spec (P36 B)", async () => {
		const { html } = await get("/design-system");
		// Each specimen up to the next one (the picker inside the first has a section of its own).
		const part = (id: string, next: string) =>
			html.split(`id="${id}"`)[1]?.split(`id="${next}"`)[0] ?? "";
		// The row: "Price changed?" in ink, then what was paid in muted words.
		const row = part("bill-row", "bill-finding");
		expect(row).toContain(
			'<span class="block leading-6">Price changed?</span>',
		);
		expect(row).toContain("Paid $17.99 on Oct 3");
		// The page: the sentence, the one primary action and the terracotta text one, as inert forms.
		const page = part("bill-occurrence", "bill-row");
		expect(page).toContain("Netflix charged $17.99 on Oct 3, not $15.49.");
		expect(page).toContain("Update the bill to $17.99");
		expect(page).toContain("Not this bill");
		// An excluded payment in the picker says so in words.
		expect(page).toContain("Sep 23 · Excluded");
		expect(page).toContain("How it&#39;s used");
		for (const [, label] of USE_SPEC_PARTS)
			expect(page).toContain(`<dt class="font-medium">${label}</dt>`);
		// DESIGN.md says what each component does with it.
		expect(design).toMatch(/\| BillRow \|[^\n]*Price changed\?[^\n]*in ink/);
		expect(design).toMatch(
			/\| PriceChanged \|[^\n]*Update the bill to \$17\.99[^\n]*Not this bill/,
		);
		expect(design).toMatch(/\| BillPaymentPicker \|[^\n]*Excluded/);
	});

	it("words the catalog's one Why? beside Bills' summary, and says no heading or Trends group carries one (decision 121)", async () => {
		const { html } = await get("/design-system");
		// The WhyLink specimen leads with the Bills summary sentence and its one Why?.
		const why = html.split('id="why-link"')[1]?.split("</section>")[0] ?? "";
		expect(why).toContain(
			'5 bills to pay soon, $1,062.49 in all<span aria-hidden="true" class="not-italic">·</span><span class="font-sans not-italic"><a href="/how-it-works#bills" aria-label="Why? bills to pay soon"',
		);
		// The BillRow specimen says its status headings carry no Why?, and draws none.
		const bills =
			html.split('id="bill-row"')[1]?.split('id="bill-finding"')[0] ?? "";
		expect(bills).toContain(
			"each status heading ends with its total and carries no Why? (decision 121: Bills&#39; one Why? sits beside its summary sentence",
		);
		expect(bills).not.toContain('aria-label="Why?');
		// The TrendGroup specimen: no group carries a Why?, so its groups link nowhere.
		const groups =
			html.split('id="trend-group"')[1]?.split('id="trend-row"')[0] ?? "";
		expect(groups).toContain('id="ds-going-well-title"');
		expect(groups).toContain('id="ds-worth-a-look-title"');
		expect(groups).toContain(
			"No group carries a Why? (decision 121): Trends&#39; headline keeps the page&#39;s one.",
		);
		expect(groups).not.toContain("how-it-works#trends");
	});

	it("shows both pickers' payments as rows, the closest five then Show all N charges (#645, P138 A)", async () => {
		const { html } = await get("/design-system");
		const bill =
			html.split('id="bill-occurrence"')[1]?.split('id="bill-row"')[0] ?? "";
		const plan =
			html.split('id="planned-expense"')[1]?.split('id="bill-finding"')[0] ??
			"";
		expect(bill).toContain("Show all 7 charges");
		expect(bill).toContain("Show all 6 charges");
		expect(plan).toContain("Show all 6 charges");
		expect(design).toMatch(/\| PaymentRow \|/);
	});

	it("shows the ledger's states in the bill page's specimen: paid, found, folded closed and open, and no filled pill (#604)", async () => {
		const { html } = await get("/design-system");
		const page =
			html.split('id="bill-occurrence"')[1]?.split('id="bill-row"')[0] ?? "";
		for (const words of [
			"Paid Oct 15 · $2.99",
			"A $2.99 charge on Sep 23 looks like this",
			"April to August",
			"5 months with no payment",
			"Due · Part paid: $600 of $1,200",
		])
			expect(page).toContain(words);
		expect(page).not.toContain("rounded-control bg-band px-2");
	});

	it("shows a credit-corrected payment on the bill page's specimen as unpaid, with Link a payment and no part-paid words (#469)", async () => {
		const { html } = await get("/design-system");
		const page =
			html.split('id="bill-occurrence"')[1]?.split('id="bill-row"')[0] ?? "";
		// The state runs from its label to the next state's label.
		const state =
			page
				.split(
					'text-sm font-medium text-muted">Credit-corrected payment (reads unpaid)</p>',
				)[1]
				?.split('text-sm font-medium text-muted">')[0] ?? "";
		expect(state).toContain("-$100.00");
		expect(state).toContain("Link a payment");
		expect(state).toContain("Not this one: Harbor Property -$100.00 on Oct 1");
		expect(state).not.toContain("Part paid");
		expect(state).not.toContain("Link another payment");
		// DESIGN.md names each Not this one by its payment, as #205 asks, and says a credit reads unpaid (#469).
		expect(design).toMatch(
			/\| LedgerMonth, LedgerDisclosure[^\n]*#469[^\n]*Not this one: Harbor Property \$600\.00 on Oct 1/,
		);
	});

	it("says in DESIGN.md that a paid month's check hangs in the margin, so every month's name lines up (decision 125, #682)", () => {
		expect(design).toMatch(
			/\| LedgerMonth, LedgerDisclosure[^\n]*a paid month's check hangs in the margin left of its name[^\n]*decision 125/,
		);
	});

	it("names the ledger, the found row and the fold in the bill page's specimen sentence (#604)", async () => {
		const { html } = await get("/design-system");
		const page =
			html.split('id="bill-occurrence"')[1]?.split('id="bill-row"')[0] ?? "";
		const sentence =
			page.match(/<p class="mt-1 max-w-prose text-muted">([^<]*)<\/p>/)?.[1] ??
			"";
		for (const words of [
			"ledger of months",
			"looks like this",
			"Link it",
			"fold",
		])
			expect(sentence).toContain(words);
	});

	it("says in the price offer's use spec what Update checks, with no count of prices (#422)", async () => {
		const { html } = await get("/design-system");
		const page =
			html.split('id="bill-occurrence"')[1]?.split('id="bill-row"')[0] ?? "";
		// Named by what it checks: the payment, its charge, the month's amount and the bill's current one.
		expect(page).toContain(
			"Update saves only if the payment, its charge, the month&#39;s amount and the bill&#39;s current amount are all still the ones the page showed.",
		);
		expect(html).not.toContain("saves only the two prices");
	});

	it("shows the picker a month choice finds empty, with its month choices kept (#323)", async () => {
		const { html } = await get("/design-system");
		const page =
			html.split('id="bill-occurrence"')[1]?.split('id="bill-row"')[0] ?? "";
		// The state's picker, found by the label above it.
		const pickerAfter = (label: string) =>
			page
				.split(`>${label}</p>`)[1]
				?.match(/<section id="payment-picker"[\s\S]*?<\/section>/)?.[0] ?? "";
		// Six pickers: the one with payments, the one with a payment turned away (#340), the one with seven payments under Show all (#645),
		// the one whose turned-away payment is checked inside the fold, the page's empty one, and a chosen month with none.
		expect(page.match(/<section id="payment-picker"/g)).toHaveLength(6);
		const chosen = pickerAfter("Chosen month with no payments");
		expect(chosen).toContain("No payments to link");
		expect(chosen.match(/name="period"/g)).toHaveLength(2);
		const october =
			chosen.match(/<input[^>]*name="period" value="2026-10"[^>]*>/)?.[0] ?? "";
		expect(october).toMatch(/\bchecked\b/);
		expect(october).toMatch(/\bautofocus\b/);
		// Nothing to link, so no payment choice, no Link button and no Cancel.
		expect(chosen).not.toContain('name="transaction_id"');
		expect(chosen).not.toContain('type="submit"');
		expect(chosen).not.toContain(">Cancel<");
		// The page's own empty picker keeps its look: the empty state alone, no month choices.
		const empty = pickerAfter("Empty picker");
		expect(empty).toContain("No payments to link");
		expect(empty).not.toContain('name="period"');
		expect(design).toMatch(
			/\| BillPaymentPicker \|[^\n]*the month choices stay below the "No payments to link" empty state/,
		);
		expect(design).toMatch(
			/\| BillPaymentPicker \|[^\n]*announced once, through the announcer/,
		);
	});

	it("shows this month's part-paid occurrence as Due, not Overdue, with its part-paid sentence (#205)", async () => {
		const { html } = await get("/design-system");
		// The state runs from its label (the apostrophe may be escaped) to the next state's label.
		const start = html.search(/Part paid \(this month(&#39;|')s, still due\)/);
		const end = html.indexOf("Part paid, an earlier month", start);
		const state = start > -1 && end > start ? html.slice(start, end) : "";
		expect(state).toContain("Due · Part paid: $600 of $1,200");
		expect(state).not.toContain("Overdue");
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
		expect(section).toContain('aria-label="Rent is at the largest budget"');
		// Each adjusting row is a link, between its − and +, as on Home.
		expect(section).toMatch(
			/id="ds-nudge-1-down"[\s\S]*?<a href="\/design-system\/bottom-sheet"[\s\S]*?id="ds-nudge-1-up"/,
		);
		// Adjust and Done move between the two states here; they don't leave for Home.
		expect(section).toContain('href="#adjust-on"');
		expect(section).toContain('href="#adjust-off"');
		expect(section).not.toMatch(/href="\/(\?adjust=1)?"/);
	});

	it("describes each picture of Home's top in words, for screen readers (#92)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="home-top"')[1]?.split("</section>")[0] ?? "";
		const labels = [...section.matchAll(/role="img" aria-label="([^"]*)"/g)]
			.map((m) => m[1] ?? "")
			// The pictures of Home itself, not others that mention it ("Go to Home" on the 404 page).
			.filter((l) => l.startsWith("Home"));
		// The no-budget picture (#519) has its own numbers, so the four examples of October are checked apart from it.
		const noBudget =
			labels.find((l) => l.includes("before any budget is set")) ?? "";
		const examples = labels.filter((l) => l !== noBudget);
		expect(labels).toHaveLength(5);
		expect(examples).toHaveLength(4);
		for (const label of examples) {
			expect(label).toContain("Safe to spend $283");
			expect(label).toContain("Eating Out is $36 over");
		}
		expect(examples[0]).toContain("12 need a category");
		expect(examples[0]).toContain("Groceries $412 of $700");
		expect(examples[3]).not.toContain("need a category");
		expect(examples[1]).toContain("About $15.03 a day for the 27 days left");
		expect(noBudget).toContain("Safe to spend −$45");
		expect(noBudget).toContain("No budgets set yet.");
		expect(noBudget).not.toContain("Over budget");
	});

	it("draws the bottom sheet on its own page", async () => {
		const { html } = await get("/design-system/bottom-sheet");
		expect(html).toMatch(
			/<section role="dialog" aria-labelledby="ds-sheet-title"/,
		);
		expect(html).toContain('id="ds-sheet-title"');
		// The title takes focus when the sheet opens, as the app's sheets' titles do (sheet.js, #87).
		const title = html.match(/<h2 id="ds-sheet-title"[^>]*>/)?.[0] ?? "";
		expect(title).toContain('tabindex="-1"');
		expect(title).toContain("autofocus");
		expect(html).toContain("Count as income");
		expect(html).toContain("Reviewed as a refund or other non-income credit");
		// The sheet draws both as the edit panel does: switches, not chips (P120 B, decision 111).
		for (const name of ["ds-income", "ds-credit-reviewed"]) {
			const at = html.indexOf(`name="${name}"`);
			const tag = html.slice(
				html.lastIndexOf("<input", at),
				html.indexOf(">", at),
			);
			expect(tag).toContain('role="switch"');
		}
		expect(design).toMatch(
			/Edit panel layout[^\n]*Count as income[^\n]*Reviewed as a refund or other non-income credit/,
		);
	});

	it("has no links that go nowhere: no specimen links back to the catalog itself", async () => {
		const { html } = await get("/design-system");
		expect(html).not.toMatch(/href="\/design-system#/);
	});

	it("keeps the month-history visual specimen's month links inert", async () => {
		const { html } = await get("/design-system");
		const start = html.lastIndexOf(
			"<section",
			html.indexOf('id="home-month-history"'),
		);
		let depth = 0;
		let end = html.length;
		for (const match of html
			.slice(start)
			.matchAll(/<section\b[^>]*>|<\/section>/g)) {
			depth += match[0] === "</section>" ? -1 : 1;
			if (depth === 0) {
				end = start + (match.index ?? 0) + match[0].length;
				break;
			}
		}
		const section = html.slice(start, end);
		expect(section).toContain("w-[320px]");
		const openDivs: boolean[] = [];
		for (const match of section.matchAll(/<div\b[^>]*>|<\/div>|<a\b[^>]*>/g)) {
			const tag = match[0];
			if (tag === "</div>") openDivs.pop();
			else if (tag.startsWith("<div"))
				openDivs.push(/\sinert(?:\s|>|=)/.test(tag));
			else expect(openDivs, tag).toContain(true);
		}
	});

	it("keeps the RuleOffer specimen's forms inside an inert wrapper, so Yes cannot post", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="rule-offer"')[1]?.split("</section>")[0] ?? "";
		// The RuleOffer's two forms and the Organize question's one form are present, so the loop below cannot pass by finding none (#353).
		expect(section.match(/<form\b/g)).toHaveLength(3);
		const openDivs: boolean[] = [];
		for (const match of section.matchAll(
			/<div\b[^>]*>|<\/div>|<form\b[^>]*>/g,
		)) {
			const tag = match[0];
			if (tag === "</div>") openDivs.pop();
			else if (tag.startsWith("<div"))
				openDivs.push(/\sinert(?:\s|>|=)/.test(tag));
			else expect(openDivs, tag).toContain(true);
		}
	});

	it("gives the rule-offer section's heading and its two question samples different ids, so the catalog has no duplicate id (#353)", async () => {
		const { html } = await get("/design-system");
		// The section's own heading (Specimen's `${id}-title`), then RuleOffer's and GroupRuleOffer's samples. A repeated id
		// would hide one heading from screen readers and from the labelled section.
		const titles = [
			...html.matchAll(/\sid="([^"]*rule-offer[^"]*-title)"/g),
		].map((match) => match[1]);
		expect(titles).toEqual([
			"rule-offer-title",
			"rule-offer-sample-title",
			"group-rule-offer-sample-title",
		]);
	});

	it("gives each notify control drawing its own help line, so no button points at another drawing's paragraph (#763)", async () => {
		const { html } = await get("/design-system");
		// Each NotifyControl drawing, and the reading screen's drawings, draws a button described by its help line. A shared id would
		// make aria-describedby point at another drawing's paragraph. The app keeps the one id, notify-help. HomeSetup's sorting
		// drawing went with Home's setup (#772, part 2), so the reading screen's own drawings are the ones counted here.
		const described = [
			...html.matchAll(/aria-describedby="(notify-help[^"]*)"/g),
		].map((match) => match[1] ?? "");
		expect(described).toHaveLength(6);
		expect(new Set(described).size).toBe(described.length);
		for (const id of described)
			expect(html.match(new RegExp(`\\sid="${id}"`, "g")), id).toHaveLength(1);
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

	it("renders one Feedback button, never fixed, and makes the visual form inert", async () => {
		const { html } = await get("/design-system");
		const button = html.slice(html.indexOf('id="feedback-button"'));
		// The link sits inside the inert wrapper: no </div> between the wrapper and the link.
		expect(button.slice(0, button.indexOf("<section"))).toMatch(
			/<div inert[^>]*>(?:(?!<\/div>)[\s\S])*href="\/feedback"/,
		);
		// Every Feedback link is in the top line or the sidebar, and none is fixed (P123 A).
		const feedbackLinks = [
			...html.matchAll(/<a href="\/feedback" class="([^"]*)"/g),
		];
		expect(feedbackLinks.length).toBeGreaterThan(0);
		for (const [, classes] of feedbackLinks) {
			expect(classes).not.toMatch(/\bfixed\b/);
		}
		const formSpecimen = specimens(html).find((tag) =>
			tag.includes('id="feedback-form"'),
		);
		// The form is inert, but the specimen's title and sentence aren't.
		expect(formSpecimen).not.toContain("inert");
		const body = html.slice(html.indexOf('id="feedback-form"'));
		expect(body.slice(0, body.indexOf("<section"))).toMatch(
			/<div inert[^>]*>[\s\S]*<form/,
		);
	});

	it("loads the catalog's own script, which fires sample toasts", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('src="/js/ds.js"');
		expect(html).toMatch(/data-ds-toast="success"/);
		expect(html).toMatch(/data-ds-toast="error"/);
	});

	it("gives the Show an Undo toast button its 10-second expiry, and ds.js passes it on", async () => {
		const { html } = await get("/design-system");
		const undo =
			html.match(/<button[^>]*data-ds-undo="catalog-demo-token"[^>]*>/)?.[0] ??
			"";
		expect(undo).toContain('data-ds-undo-expires-in-ms="10000"');
		expect(dsScript).toMatch(
			/undoExpiresInMs:\s*Number\(button\.dataset\.dsUndoExpiresInMs\)/,
		);
	});

	it("shows the Transactions heading wrapping beside Select and the long name in the Toast specimen", async () => {
		const { html } = await get("/design-system");
		expect(design).toMatch(
			/\| Page title \/ month \|[^\n]*Transactions page heading can wrap beside Select\./,
		);
		const toast = html.split('id="toast"')[1]?.split("</section>")[0] ?? "";
		expect(toast).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUV");
	});

	it("shows a disconnected bank, and DESIGN.md's BankGroup row mentions it", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain("A disconnected bank, its history kept");
		expect(html).toContain("Fix connection");
		expect(html).toContain("Link a bank");
		expect(design).toMatch(/\| BankGroup \|[^\n]*disconnected/);
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

	it("shows the bar's ticks-not-on-this-page line closed and open, and the over-100 warning, in the catalog (#350)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="selection-action-bar"')[1]?.split("</section>")[0] ?? "";
		expect(section).toMatch(/<details(?![^>]* open)[^>]*>/);
		expect(section).toMatch(/<details[^>]*\sopen(?=[\s>=])/);
		expect(section).toContain("3 not on this page");
		expect(section).toContain("101 selected");
		expect(section).toMatch(
			/<p[^>]*role="alert"[^>]*>[\s\S]*?Select 100 or fewer transactions\.<\/p>/,
		);
	});

	it("shows the over-100 unticked words in brick, in the catalog (#423)", async () => {
		const { html } = await get("/design-system");
		const section =
			html.split('id="selection-action-bar"')[1]?.split("</section>")[0] ?? "";
		expect(section).toMatch(
			/<p[^>]*role="alert"[^>]*>[\s\S]*?Untick 100 or fewer\. To leave out more, filter the list first\.<\/p>/,
		);
	});
});

describe("the ledger form (P72 A, decisions 75, 79, 80)", () => {
	it.each(["ledger-field", "due-row", "folded-row", "sheet-footer"])(
		"gives %s its whole use spec, beside its specimen",
		async (id) => {
			const { html } = await get("/design-system");
			expect(specimens(html).some((tag) => tag.includes(`id="${id}"`))).toBe(
				true,
			);
			const section = html.split(`id="${id}"`)[1]?.split("</section>")[0] ?? "";
			for (const [, label] of USE_SPEC_PARTS) {
				expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
			}
		},
	);

	it("shows each piece in its component's own tag, with the states the form needs", async () => {
		const { html } = await get("/design-system");
		const tagOf = (id: string) =>
			specimens(html).find((tag) => tag.includes(`id="${id}"`)) ?? "";
		expect(tagOf("ledger-field")).toContain('data-ds-components="LedgerField"');
		expect(tagOf("due-row")).toContain('data-ds-components="DueRow"');
		expect(tagOf("folded-row")).toContain('data-ds-components="FoldedRow"');
		expect(tagOf("sheet-footer")).toContain('data-ds-components="SheetFooter"');
		// The footer is drawn as the savings sheet is: a visual, inert sheet, since its buttons post.
		expect(tagOf("sheet-footer")).toContain('data-ds-tier="visual"');
		const field =
			html.split('id="ledger-field"')[1]?.split("</section>")[0] ?? "";
		expect(field).toContain('aria-invalid="true"');
		expect(field).toMatch(/role="alert"[^>]*>Enter a name for the bill\./);
		const due = html.split('id="due-row"')[1]?.split("</section>")[0] ?? "";
		for (const words of [
			"Due on the 1st every month",
			"Due on Fridays every week",
			"starting in",
			"in",
		]) {
			expect(due).toContain(words);
		}
		const folded =
			html.split('id="folded-row"')[1]?.split("</section>")[0] ?? "";
		// Three ledger states, then the category row's closed and open states (P120 B).
		expect(folded.match(/<details/g)).toHaveLength(5);
		expect(folded.match(/<details[^>]* open=""/g)).toHaveLength(2);
	});

	it("links the ledger sheet page from its group, and the page is a catalog page", async () => {
		const { html } = await get("/design-system");
		expect(html).toContain('href="/design-system/ledger-sheet"');
		expect(html).toContain('href="#ledger-form"');
		const { res, html: page } = await get("/design-system/ledger-sheet");
		expect(res.status).toBe(200);
		expect(page).toContain(
			"<title>Ledger sheet · Design system · Tally</title>",
		);
	});

	it("pins Cancel and Save under the middle of the sheet, which scrolls (gap E8)", async () => {
		const { res, html } = await get("/design-system/ledger-sheet");
		expect(res.status).toBe(200);
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-labelledby="ledger-sheet-title"');
		expect(html).toMatch(
			/<h2 id="ledger-sheet-title" class="font-serif text-2xl font-semibold tracking-tight"[^>]*>\s*Add a bill\s*<\/h2>/,
		);
		// The title takes focus when the sheet opens, as the app's sheets' titles do (sheet.js, #87).
		const title = html.match(/<h2 id="ledger-sheet-title"[^>]*>/)?.[0] ?? "";
		expect(title).toContain('tabindex="-1"');
		expect(title).toContain("autofocus");
		const scroller = html.indexOf("min-h-0 flex-1 overflow-y-auto");
		const form = html.indexOf('<form id="ledger-sheet-form"');
		const formEnd = html.indexOf("</form>");
		const footer = html.indexOf("shrink-0 border-t border-rule");
		const save = html.indexOf('id="ledger-sheet-save"');
		expect(scroller).toBeGreaterThan(0);
		expect(form).toBeGreaterThan(scroller);
		expect(formEnd).toBeGreaterThan(form);
		expect(footer).toBeGreaterThan(formEnd);
		expect(save).toBeGreaterThan(footer);
		const saveTag =
			html.match(/<button [^>]*id="ledger-sheet-save"[^>]*>/)?.[0] ?? "";
		expect(saveTag).toContain('type="submit"');
		expect(saveTag).toContain('form="ledger-sheet-form"');
		expect(html.slice(footer, save)).toContain(
			'href="/design-system#ledger-form"',
		);
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("form-action 'none'");
	});

	it("turns the footer's Save off while the form posts: the form names it by id, since it sits outside the form", async () => {
		const { html } = await get("/design-system/ledger-sheet");
		const formTag = html.match(/<form id="ledger-sheet-form"[^>]*>/)?.[0] ?? "";
		expect(formTag).toContain('hx-disable="#ledger-sheet-save"');
		expect(formTag).toContain('hx-indicator="#ledger-sheet-save"');
		const saveTag =
			html.match(/<button [^>]*id="ledger-sheet-save"[^>]*>/)?.[0] ?? "";
		expect(saveTag).toContain('form="ledger-sheet-form"');
		expect(html.slice(html.indexOf(saveTag))).toContain("Saving…");
	});

	it("says the page's Save is drawn only, and the footer spec keeps its busy and off wording", async () => {
		const { html } = await get("/design-system/ledger-sheet");
		expect(html).toContain("Save is drawn only");
		const { html: catalog } = await get("/design-system");
		const footer =
			catalog.split('id="sheet-footer"')[1]?.split("</section>")[0] ?? "";
		expect(footer).toContain("is off while the form posts");
	});

	it("opens Category with all 50 categories as chips, and keeps Match payments from closed", async () => {
		const { html } = await get("/design-system/ledger-sheet");
		expect(html.match(/name="ledger-sheet-category"/g)).toHaveLength(50);
		expect(html).toMatch(
			/<details class="group border-b border-rule" open=""><summary[\s\S]*?<span class="text-muted">Category<\/span>/,
		);
		expect(html).toMatch(
			/<details class="group border-b border-rule"><summary[\s\S]*?<span class="text-muted">Match payments from<\/span>/,
		);
		expect(html).toContain('<span class="text-muted">Category</span>');
	});

	it("documents the pieces, the ledger title role and the pattern in DESIGN.md (P72 A)", () => {
		expect(design).toMatch(
			/\| Sheet title and amount \|[^\n]*\n\| Ledger sheet title \| font-serif, 2xl, semibold, tight tracking/,
		);
		expect(design).toMatch(
			/\| BottomSheet \|[^\n]*an optional pinned footer \(SheetFooter\)/,
		);
		expect(design).toMatch(
			/\| BottomSheet \|[^\n]*\n\| LedgerField \|[^\n]*\n\| DueRow \|[^\n]*\n\| FoldedRow \|[^\n]*\n\| SheetFooter \|/,
		);
		expect(design).toMatch(
			/Ledger form \(P72 A, decisions 75, 79, 80\)[^\n]*one column of small muted labels/,
		);
	});
});

describe("the catalog outside the demo", () => {
	it("doesn't exist in production", async () => {
		for (const path of [
			"/design-system",
			"/design-system/bottom-sheet",
			"/design-system/ledger-sheet",
		]) {
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

describe("GET /design-system: Apple Card's group, file field and sheet (#766)", () => {
	it("draws the group as a bank's is: the date line, the card's balance, Upload a file and Manage", async () => {
		const { html: raw } = await get("/design-system");
		const html = raw.replaceAll("&#39;", "'");
		const group =
			html.split('id="apple-card-group"')[1]?.split('id="file-field"')[0] ?? "";
		expect(group).toContain("Updated through Oct 18");
		expect(group).toContain("Balance as of Oct 18");
		expect(group).toContain("-$1,240.18");
		expect(group).toContain("Upload a file");
		expect(group).toContain("Remove Apple Card");
		expect(group).toContain("isn't in net worth yet.");
	});

	it("draws the removed group with no amount, no Upload and no Manage, and the demo's with no Manage", async () => {
		const { html: raw } = await get("/design-system");
		const html = raw.replaceAll("&#39;", "'");
		const group =
			html.split('id="apple-card-group"')[1]?.split('id="file-field"')[0] ?? "";
		const removed =
			group.split("and no Manage</p>")[1]?.split("</section>")[0] ?? "";
		expect(removed).toContain("Removed</p>");
		expect(removed).not.toContain("Upload a file");
		expect(removed).not.toContain("Manage");
		expect(removed).not.toMatch(/tabular-nums">-?\$/);
		const demo = group.split("the same group, with no Manage</p>")[1] ?? "";
		expect(demo).toContain("Upload a file");
		expect(demo).not.toContain("Manage");
		expect(demo).not.toContain("Remove Apple Card");
	});

	it("puts FileField's error in role=alert, named by the field's description", async () => {
		const { html: raw } = await get("/design-system");
		const html = raw.replaceAll("&#39;", "'");
		expect(html).toMatch(
			/<input [^>]*id="ds-apple-card-file-error"[^>]*aria-describedby="ds-apple-card-file-error-hint ds-apple-card-file-error-error"[^>]*>/,
		);
		expect(html).toMatch(/<p id="ds-apple-card-file-error-error" role="alert"/);
	});

	it("draws the sheet's errors under their fields and the demo's sheet without fields", async () => {
		const { html: raw } = await get("/design-system");
		const html = raw.replaceAll("&#39;", "'");
		const sheet =
			html.split('id="apple-card-sheet"')[1]?.split("</section>")[0] ?? "";
		expect(sheet).toContain(
			"This isn't an Apple Card CSV. In Wallet or on card.apple.com, choose Export Transactions and pick CSV.",
		);
		expect(sheet).toContain(
			"Row 14's amount can't be read. Nothing was added.",
		);
		expect(sheet).toContain(
			"Enter the balance as dollars, like 1,240.18, or with a minus for a credit.",
		);
		expect(sheet).toContain("Add the sample");
		expect(sheet).toContain("In the demo, Tally uses a sample file.");
		expect(sheet).toContain("Optional. Left blank, Oct 18's balance stays.");
	});

	it("draws the sheet's no-JavaScript size refusal under the file field, in role=alert (the words the size gate says)", async () => {
		const { html: raw } = await get("/design-system");
		const html = raw.replaceAll("&#39;", "'");
		const sheet =
			html.split('id="apple-card-sheet"')[1]?.split("</section>")[0] ?? "";
		expect(sheet).toContain(
			"Tally couldn't tell how big this file is. Try the upload again.",
		);
		expect(sheet).toMatch(
			/<p id="ds-apple-card-size-file-error" role="alert"[^>]*>Tally couldn't tell how big this file is\. Try the upload again\.<\/p>/,
		);
	});

	it("draws Remove Apple Card's page in the catalog: its heading, both counts, the delete chip, Remove and Cancel, and the failure in role=alert, all inert with distinct ids", async () => {
		const { html: raw } = await get("/design-system");
		const html = raw.replaceAll("&#39;", "'");
		const page =
			html.split('id="apple-card-remove"')[1]?.split("</section>")[0] ?? "";
		expect(page).toContain("Remove Apple Card?");
		expect(page).toContain("Its 12 transactions stay");
		expect(page).toContain("Its 1 transaction stays");
		expect(page).toContain("Also delete its transactions");
		expect(page).toContain("This deletes them for good.");
		expect(page).toContain(">Remove<");
		expect(page).toContain(">Cancel<");
		expect(page).toMatch(
			/<p role="alert" class="[^"]*">Couldn't remove Apple Card\. Try again\.<\/p>/,
		);
		// Each state sits in its own inert box, so nothing in the page can take focus or post.
		expect(page.match(/<div inert/g)).toHaveLength(4);
		// The delete hint and the chip name it by its own id, so no id is drawn twice on the page.
		const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
		for (const described of page.matchAll(/aria-describedby="([^"]+)"/g)) {
			for (const ref of (described[1] ?? "").split(" ")) {
				expect(html.split(`id="${ref}"`).length - 1).toBe(1);
			}
		}
		// The page's form is the Remove page's own address, drawn with htmx's hx-ignore by the Visual specimen.
		expect(page).toContain('action="/accounts/apple-card/remove"');
	});

	it("names the submit Upload, as the spec's Cancel and Upload does, and the demo's Add the sample; DESIGN.md says the same", async () => {
		const { html: raw } = await get("/design-system");
		const html = raw.replaceAll("&#39;", "'");
		const sheet =
			html.split('id="apple-card-sheet"')[1]?.split("</section>")[0] ?? "";
		const labels = [
			...sheet.matchAll(
				/<button[^>]*id="ds-apple-card-[a-z-]+-upload"[^>]*>\s*<span class="contents[^"]*">([^<]*)<\/span>/g,
			),
		].map((match) => match[1]);
		expect(labels).toContain("Upload");
		expect(labels).toContain("Add the sample");
		for (const label of labels) {
			expect(["Upload", "Add the sample"]).toContain(label);
		}
		expect(sheet).toContain("then Cancel and Upload. On a phone");
		expect(design).toContain('then Cancel and "Upload"; the demo');
	});
});

describe("GET /design-system/proposals: P140 A, the picked banks picture (decision 133)", () => {
	it("draws A from JSX with setup-top and the real Your banks list, and none of the frozen string's ids", async () => {
		const { res, html } = await get("/design-system/proposals");
		expect(res.status).toBe(200);
		const start = html.indexOf(">A · Your banks under the status");
		const end = html.indexOf(">B · The banks under Link your bank</h4>");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const picture = html.slice(start, end);
		expect(picture).toContain('<section id="setup-top" class="mt-2">');
		expect(picture).toContain(
			'<div class="flex items-center justify-end gap-4">',
		);
		expect(picture).toContain('<section id="your-banks"');
		expect(picture).toContain(
			"Link every bank and card you use now, so your first questions cover them all.",
		);
		for (const id of [
			"setup-title",
			"setup-status",
			"setup-next",
			"data-link-bank-focus",
		]) {
			expect(picture).not.toContain(id);
		}
	});
});
