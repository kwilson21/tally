/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import {
	NewCategoryCard,
	OrganizeNewCategoryCard,
} from "../src/views/suggestion-card";
import { AskFirst } from "../src/views/suggestion-review";

// Decision 120 (P135 A): one category-suggestion card, drawn and worded the same wherever Tally asks.
// Apostrophes come out as &#39; in the markup, so the words are compared escaped.
const esc = (text: string) => text.replace(/'/g, "&#39;");
const TODAY = "2026-10-16";

const rows = [
	{
		id: 7103,
		name: "Banfield Pet Hospital",
		amountCents: 18900,
		date: "2026-08-21",
	},
	{ id: 7102, name: "Petsmart", amountCents: 2399, date: "2026-08-14" },
	{ id: 7101, name: "Chewy", amountCents: 6412, date: "2026-08-08" },
];

/** The Settings card's form and answers, as settings.tsx passes them. */
const SETTINGS = {
	name: "Pet Care",
	rows,
	today: TODAY,
	tickName: "ids" as const,
	form: {
		method: "post",
		action: "/settings/suggestions/7001/create",
		"hx-post": "/settings/suggestions/7001/create",
		"hx-target": "#categories",
		"hx-select": "#categories",
		"hx-swap": "outerHTML",
	},
	answers: {
		create: { type: "submit", name: "action", value: "create" },
		no: {
			type: "submit",
			formaction: "/settings/suggestions/7001/dismiss",
			"hx-post": "/settings/suggestions/7001/dismiss",
			"hx-target": "#categories",
			"hx-select": "#categories",
			"hx-swap": "outerHTML",
		},
	},
};

describe("NewCategoryCard: one card, one set of words", () => {
	it("draws the sparkle line, one headline, the hint and ruled rows with one checkbox each", () => {
		const html = String(<NewCategoryCard {...SETTINGS} />);
		expect(html).toContain(esc("Tally's guess"));
		expect(html).toContain("A new category: Pet Care");
		expect(html.match(/<h2\b/g)?.length).toBe(1);
		expect(html).toContain(esc("Untick any that don't belong."));
		expect(html.match(/type="checkbox"/g)?.length).toBe(3);
		expect(html).toContain("divide-y divide-rule border-y border-rule");
		expect(html).not.toContain("rounded-full"); // no pills
		expect(html).not.toContain("border-dashed"); // no dashed box or dashed icon
	});

	it("names each checkbox by its row: the name, amount and day", () => {
		const html = String(<NewCategoryCard {...SETTINGS} />);
		expect(html).toMatch(
			/<label[^>]*>\s*<input[^>]*name="ids" value="7101"[^>]*>[\s\S]*?Chewy[\s\S]*?\$64\.12[\s\S]*?Aug 8/,
		);
	});

	it("uses the given checkbox name, so Settings sends ids and the Suggestions page sends ticked", () => {
		const settings = String(<NewCategoryCard {...SETTINGS} />);
		const suggestions = String(
			<NewCategoryCard {...SETTINGS} tickName="ticked" />,
		);
		expect(settings).toContain('name="ids"');
		expect(settings).not.toContain('name="ticked"');
		expect(suggestions).toContain('name="ticked"');
		expect(suggestions).not.toContain('name="ids"');
	});

	it("sends a hidden shown field for every row, so the route knows what was offered", () => {
		const html = String(<NewCategoryCard {...SETTINGS} />);
		for (const row of rows)
			expect(html).toContain(`name="shown" value="${row.id}"`);
	});

	it("gives each row an optional note labelled by its name, under the row", () => {
		const html = String(
			<NewCategoryCard {...SETTINGS} ticked={[7103, 7102]} />,
		);
		expect(html).toContain('name="note_7101"');
		expect(html).toContain(esc("A note for Chewy (optional)"));
		expect(html).toContain('name="note_7102"');
	});

	it("ends with Create {name} (primary), No (quiet) and decision 89's Why? after No", () => {
		const html = String(<NewCategoryCard {...SETTINGS} />);
		expect(html).toContain(">Create Pet Care<");
		const no = html.indexOf(">No<");
		const why = html.indexOf('aria-label="Why? suggested categories"');
		expect(no).toBeGreaterThan(-1);
		expect(why).toBeGreaterThan(no);
		expect(html).toContain('formaction="/settings/suggestions/7001/dismiss"');
	});

	it("never says Dismiss, Not now or Suggested in its own words", () => {
		const html = String(<NewCategoryCard {...SETTINGS} />);
		expect(html).not.toContain("Dismiss");
		expect(html).not.toContain("Not now");
		expect(html).not.toContain("Suggested:");
		expect(html).not.toContain("Maybe new");
	});

	it("says Add to or Restore for a name the family already has, as the card always has", () => {
		expect(
			String(<NewCategoryCard {...SETTINGS} existing="Pet Care" />),
		).toContain(">Add to Pet Care<");
		expect(
			String(
				<NewCategoryCard {...SETTINGS} existing="Pet Care" archived={true} />,
			),
		).toContain(">Restore Pet Care<");
	});

	it("shows its error in the card, announced as an alert", () => {
		const html = String(
			<NewCategoryCard {...SETTINGS} error="Tick at least one transaction." />,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Tick at least one transaction.");
	});

	it("is the Suggestions page's one headline, with its id, and takes focus when drawn in place", () => {
		const html = String(
			<NewCategoryCard {...SETTINGS} titleId="suggestion-title" focus />,
		);
		expect(html).toContain('id="suggestion-title"');
		expect(html).toContain('tabindex="-1"');
	});

	it("has no headline id on Settings, where one page holds several cards", () => {
		expect(String(<NewCategoryCard {...SETTINGS} />)).not.toContain(
			'id="suggestion-title"',
		);
	});
});

describe("OrganizeNewCategoryCard: the short form above Organize's chips", () => {
	const ORGANIZE = {
		name: "Pet Care",
		action: "/transactions/organize/suggestion",
		suggestionId: 7001,
		others: 2,
		shown: [7101, 7102, 7103],
	};

	it("says the suggestion covers this merchant and the others, and offers Create and Pick a category below", () => {
		const html = String(<OrganizeNewCategoryCard {...ORGANIZE} />);
		expect(html).toContain(esc("Tally's guess"));
		expect(html).toContain(
			"Tally suggested a new category for this and 2 more: Pet Care",
		);
		expect(html).toContain(">Create Pet Care<");
		expect(html).toContain('href="#organize-category"');
		expect(html).toContain("Pick a category below");
		expect(html).not.toContain('role="alert"');
	});

	it("reads in the singular when the suggestion is only this merchant's", () => {
		const html = String(<OrganizeNewCategoryCard {...ORGANIZE} others={0} />);
		expect(html).toContain("Tally suggested a new category for this: Pet Care");
	});

	it("posts the suggestion's id and one hidden shown per purchase, with no ticks or note fields", () => {
		const html = String(<OrganizeNewCategoryCard {...ORGANIZE} />);
		expect(html).toContain('name="suggestion" value="7001"');
		for (const id of ORGANIZE.shown)
			expect(html).toContain(`name="shown" value="${id}"`);
		expect(html).not.toContain('type="checkbox"');
		expect(html).not.toContain("note_");
	});

	it("shows a refused Create's reason under the headline, as Settings' card does", () => {
		const html = String(
			<OrganizeNewCategoryCard
				{...ORGANIZE}
				error="Tally has room for 50 categories. Archive one to add another."
			/>,
		);
		expect(html).toContain(
			'<p role="alert" class="text-sm text-over">Tally has room for 50 categories. Archive one to add another.</p>',
		);
	});

	it("shares Organize's request queue, so every submit button on the page is disabled while one Create or Save runs", () => {
		const html = String(<OrganizeNewCategoryCard {...ORGANIZE} />);
		expect(html).toContain('hx-sync="#organize-page:drop"');
		expect(html).toContain('hx-disable="#organize-page button[type=submit]"');
	});

	it("has no No and no Dismiss", () => {
		const html = String(<OrganizeNewCategoryCard {...ORGANIZE} />);
		expect(html).not.toContain(">No<");
		expect(html).not.toContain("Dismiss");
	});
});

describe("AskFirst takes the form it answers to", () => {
	const ask = {
		kind: "new_category" as const,
		id: "new-7001",
		name: "Pet Care",
		stores: [{ merchantKey: "CHEWY.COM", label: "Chewy" }],
	};

	it("answers to the Suggestions page by default", () => {
		const html = String(<AskFirst action="/settings/suggestions" {...ask} />);
		expect(html).toContain('hx-target="#suggestions-page"');
	});

	it("answers in place when a target is given, as Settings' does", () => {
		const html = String(
			<AskFirst
				action="/settings/suggestions/7001/dismiss"
				target="#categories"
				{...ask}
			/>,
		);
		expect(html).toContain('hx-target="#categories"');
		expect(html).toContain('hx-select="#categories"');
		expect(html).toContain('hx-disable="#categories button[type=submit]"');
		expect(html).toContain('hx-sync="#categories:drop"');
		expect(html).not.toContain("#suggestions-page");
	});
});
