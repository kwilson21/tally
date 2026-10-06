import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import design from "../DESIGN.md?raw";
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

	it("shows every component in DESIGN.md's table", async () => {
		const { html } = await get("/design-system");
		const shown = specimens(html)
			.flatMap((tag) => tag.match(/data-ds-components="([^"]*)"/)?.[1] ?? "")
			.flatMap((names) => names.split(" "));
		const names = designComponents();
		expect(names.length).toBeGreaterThan(15);
		for (const name of names) expect(shown).toContain(name);
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
			...PROGRESS_ROWS.map((s) => ProgressRow(s.props)),
			...ADJUST_ROWS.map((row) => ProgressRow(row)),
			AdjustLink({ adjusting: false, href: "#adjust-on" }),
			AdjustLink({ adjusting: true, href: "#adjust-off" }),
			...TRANSACTION_ROWS.map((s) => TransactionRow({ row: s.row })),
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
			BudgetDiagram(BUDGET_EXAMPLE),
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
		// FormField: its label points at the control, and its error is announced.
		expect(html).toContain('for="ds-name"');
		expect(html).toMatch(/<p id="ds-name-error-error" role="alert"/);
		// Layout: the toast region and the announcer are this page's own.
		expect(html).toContain('id="toasts"');
		expect(html).toContain('id="announcer"');
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
		const tag = specimens(html).find((t) => t.includes('id="bank-line"'));
		expect(tag).toContain('data-ds-tier="visual"');
		expect(tag).toContain('data-ds-components="BankLine"');
		const section =
			html.split('id="bank-line"')[1]?.split("</section>")[0] ?? "";
		// Its words come from the real function, so the catalog can't drift from Home.
		expect(Object.values(BANK_LINES)).toHaveLength(3);
		for (const words of Object.values(BANK_LINES))
			expect(section).toContain(words.replaceAll("'", "&#39;"));
		expect(BANK_LINES.stale).toContain("hasn't synced since");
		expect(BANK_LINES.signIn).toContain("needs you to sign in again");
		expect(BANK_LINES.several).toContain("1 other bank needs a look");
		// Each picture is described in words, the bank's words and its link included.
		const labels = [...section.matchAll(/role="img" aria-label="([^"]*)"/g)]
			.map((m) => m[1] ?? "")
			.filter((l) => l.includes("Home"));
		expect(labels).toHaveLength(3);
		for (const [i, words] of [
			BANK_LINES.stale,
			BANK_LINES.signIn,
			BANK_LINES.several,
		].entries()) {
			expect(labels[i]).toContain("Safe to spend $283");
			expect(labels[i]).toContain(words.replaceAll("'", "&#39;"));
			expect(labels[i]).toContain("Check Accounts");
		}
		// The 44px link, drawn in a family app's phone (no demo banner) beside Home's real top.
		expect(section).toContain("Check Accounts");
		expect(section).toContain("min-h-11");
		expect(section).toContain("Safe to spend");
		expect(section).not.toContain("Demo data. Nothing here is real.");
		expect(section).toContain("How it&#39;s used");
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		// DESIGN.md says where it sits.
		expect(design).toMatch(
			/\| BankLine \|[^\n]*Check Accounts[^\n]*between the status sentence and the Band/,
		);
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
		expect(tag).toContain('data-ds-components="NameChoices"');
		const section =
			html.split('id="name-choices"')[1]?.split("</section>")[0] ?? "";
		// Three states, each its own radio group, and nothing posts from the catalog.
		const radios = [...section.matchAll(/<input[^>]*type="radio"[^>]*>/g)];
		expect(radios.length).toBeGreaterThanOrEqual(8);
		const groups = [
			...section.matchAll(/<input[^>]*type="radio"[^>]*name="([^"]+)"/g),
		].map((m) => m[1]);
		expect(new Set(groups).size).toBe(6);
		const chosen = radios.filter((m) => /\schecked(\s|>|=)/.test(m[0]));
		expect(chosen).toHaveLength(1);
		expect(section).not.toContain("<form");
		expect(section).not.toContain("<button");
		// Where the guesses came from, under them: the icon, "Tally's guess" and a Why?.
		expect(section).toContain("Tally&#39;s guess");
		expect(section).toContain('href="/how-it-works#names"');
		// A name the bank sent says so quietly: muted words, no icon, no Why? (P87 B).
		expect(section).toMatch(
			/<p id="ds-names-bank-source" class="text-sm text-muted">From your bank<\/p>/,
		);
		expect(section).toContain('role="alert"');
		expect(section).toContain(
			"Pick a name, keep the bank&#39;s, or type your own.",
		);
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
		expect(section).toContain('value="keep"');
		expect(section).toContain("wrap-anywhere");
		expect(section).toContain(
			"A name typed here is used instead of any name above.",
		);
		expect(section).toContain('aria-describedby="ds-names-one-own-hint"');
		for (const [, label] of USE_SPEC_PARTS) {
			expect(section).toContain(`<dt class="font-medium">${label}</dt>`);
		}
		// Never the name of the AI behind it.
		expect(section).not.toMatch(/jev|workers ai/i);
		expect(design).toMatch(
			/\| NameChoices \|[^\n]*Tally's guess[^\n]*Or your own[^\n]*without JavaScript/,
		);
		expect(design).toContain(
			"A name typed here is used instead of any name above. For all 9 transactions from this merchant.",
		);
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
			/\| ViewLinks \|[^\n]*Tidied by Tally · Straight from the bank[^\n]*aria-current[^\n]*demo only[^\n]*no JavaScript/,
		);
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
			'data-ds-components="MaybeCategory SuggestedCategoryChip"',
		);
		expect(html).toContain("Maybe new: Pet Care");
		expect(html).toContain("Tally&#39;s guess");
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
		// Four rows, each in an inert box so nothing in them can be tapped or can take focus.
		expect(section.match(/<details/g)).toHaveLength(4);
		expect(section.match(/<div inert/g)).toHaveLength(4);
		// Closed, open (the chevron's turned state is the open attribute), and the error one open too.
		expect(
			[...section.matchAll(/<details[^>]*>/g)].map((m) =>
				/\sopen(\s|>|=)/.test(m[0]),
			),
		).toEqual([false, true, true, false]);
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
		expect(page).toContain("Zelle · Sep 23 · $142.00 · Excluded");
		expect(page).toContain("How it&#39;s used");
		for (const [, label] of USE_SPEC_PARTS)
			expect(page).toContain(`<dt class="font-medium">${label}</dt>`);
		// DESIGN.md says what each component does with it.
		expect(design).toMatch(/\| BillRow \|[^\n]*Price changed\?[^\n]*in ink/);
		expect(design).toMatch(
			/\| BillOccurrenceRow \|[^\n]*Update the bill to \$17\.99[^\n]*Not this bill/,
		);
		expect(design).toMatch(/\| BillPaymentPicker \|[^\n]*Excluded/);
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
		expect(labels).toHaveLength(3);
		for (const label of labels) {
			expect(label).toContain("Safe to spend $283");
			expect(label).toContain("Eating Out is $36 over");
		}
		expect(labels[0]).toContain("12 transactions need a category");
		expect(labels[0]).toContain("Groceries $412 of $700");
		expect(labels[2]).not.toContain("need a category");
	});

	it("draws the bottom sheet on its own page", async () => {
		const { html } = await get("/design-system/bottom-sheet");
		expect(html).toMatch(
			/<section role="dialog" aria-labelledby="ds-sheet-title"/,
		);
		expect(html).toContain('id="ds-sheet-title"');
		expect(html).toContain("Count as income");
		expect(html).toContain("Reviewed as a refund or other non-income credit");
		expect(design).toMatch(
			/Edit panel layout[^\n]*Count as income[^\n]*Reviewed as a refund or other non-income credit/,
		);
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

	it("renders one fixed Feedback button and makes the visual form inert", async () => {
		const { html } = await get("/design-system");
		const button = html.slice(html.indexOf('id="feedback-button"'));
		// The link sits inside the inert wrapper: no </div> between the wrapper and the link.
		expect(button.slice(0, button.indexOf("<section"))).toMatch(
			/<div inert[^>]*>(?:(?!<\/div>)[\s\S])*href="\/feedback"/,
		);
		expect(
			html.match(
				/fixed bottom-\[calc\(var\(--feedback-bottom\)\+var\(--safe-area-bottom\)\)\] right-\[calc\(1rem\+var\(--safe-area-right\)\)\]/g,
			),
		).toHaveLength(1);
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
