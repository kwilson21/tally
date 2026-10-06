import { env } from "cloudflare:workers";
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import {
	groupNoneFit,
	MAX_MERCHANTS_SENT,
	MIN_GROUP,
	type NoneFit,
} from "../src/category-suggestions";
import { listTransactions } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { designSystem } from "../src/routes/design-system";
import { TransactionRow } from "../src/views/transaction-row";

// New category suggestions (spec §7, #51): code groups the transactions Jev was sure no category fit,
// and only a group of several asks Workers AI for a name. A single Venmo payment never does.

let n = 0;
const row = (theme: string, merchant: string, key = merchant): NoneFit => {
	n += 1;
	return { id: n, theme, merchant, merchantKey: key };
};

describe("groupNoneFit", () => {
	it("resets the demo fixture before checking its real transaction row", async () => {
		await resetDemo(env.DB, "2026-10-05", { categoryExample: true });
		await env.DB.prepare(
			"UPDATE transactions SET date = '2026-08-08' WHERE category_suggestion_id = (SELECT id FROM category_suggestions WHERE name = 'Pet Care')",
		).run();
		const result = await listTransactions(env.DB, {
			month: "all",
			category: null,
			account: null,
			uncategorized: false,
			raw: false,
			show: "all",
			q: "Chewy",
			page: 1,
		});
		const row = result.rows.find((item) => item.maybeCategoryNew);
		if (!row) throw new Error("Pet Care demo row is missing");
		expect(renderToString(TransactionRow({ row }))).toContain(
			"Maybe new: Pet Care",
		);
	});
	it("asks about a theme only once three transactions share it", () => {
		expect(MIN_GROUP).toBe(3);
		const groups = groupNoneFit([
			row("ENTERTAINMENT", "Netflix"),
			row("ENTERTAINMENT", "Hulu"),
			row("ENTERTAINMENT", "Spotify"),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.theme).toBe("ENTERTAINMENT");
		expect(groups[0]?.ids).toHaveLength(3);
	});

	it("leaves a theme with fewer than three alone, so a lone Venmo payment never prompts a category", () => {
		expect(
			groupNoneFit([
				row("TRANSFER_OUT", "Venmo"),
				row("ENTERTAINMENT", "Netflix"),
				row("ENTERTAINMENT", "Hulu"),
			]),
		).toEqual([]);
	});

	it("counts transactions, not merchants: three Netflix charges are three", () => {
		const groups = groupNoneFit([
			row("ENTERTAINMENT", "Netflix", "NETFLIX"),
			row("ENTERTAINMENT", "Netflix", "NETFLIX"),
			row("ENTERTAINMENT", "Netflix", "NETFLIX"),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.merchants).toEqual(["Netflix"]);
	});

	it("keeps each theme apart", () => {
		const groups = groupNoneFit([
			row("ENTERTAINMENT", "Netflix"),
			row("TRANSPORTATION", "Uber"),
			row("ENTERTAINMENT", "Hulu"),
			row("TRANSPORTATION", "Lyft"),
			row("ENTERTAINMENT", "Spotify"),
			row("TRANSPORTATION", "Metro"),
		]);
		expect(groups.map((g) => [g.theme, g.ids.length])).toEqual([
			["ENTERTAINMENT", 3],
			["TRANSPORTATION", 3],
		]);
	});

	it("puts the biggest group first, then themes in plain A to Z order, so every night picks alike", () => {
		const rows = [
			...["a", "b", "c"].map((m) => row("ZEBRA", m)),
			...["d", "e", "f", "g"].map((m) => row("MOON", m)),
			...["h", "i", "j"].map((m) => row("APPLE", m)),
		];
		expect(groupNoneFit(rows).map((g) => g.theme)).toEqual([
			"MOON",
			"APPLE",
			"ZEBRA",
		]);
	});

	it("lists a group's transactions in the order they were found, oldest id first", () => {
		const rows = [
			row("T", "x"),
			row("T", "y"),
			row("T", "z"),
			row("T", "w"),
		].reverse();
		const [group] = groupNoneFit(rows);
		expect(group?.ids).toEqual([...(group?.ids ?? [])].sort((a, b) => a - b));
	});

	it("names each merchant once, the most charges first, then A to Z", () => {
		const [group] = groupNoneFit([
			row("T", "Hulu", "H"),
			row("T", "Netflix", "N"),
			row("T", "Netflix", "N"),
			row("T", "Disney Plus", "D"),
		]);
		expect(group?.merchants).toEqual(["Netflix", "Disney Plus", "Hulu"]);
	});

	it("tells Workers AI about no more than ten merchants, so a long backfill can't make a long prompt", () => {
		expect(MAX_MERCHANTS_SENT).toBe(10);
		const rows = Array.from({ length: 25 }, (_, i) =>
			row("T", `Shop ${String(i).padStart(2, "0")}`),
		);
		const [group] = groupNoneFit(rows);
		expect(group?.merchants).toHaveLength(MAX_MERCHANTS_SENT);
		// Every transaction is still behind the suggestion, not only the ones named.
		expect(group?.ids).toHaveLength(25);
	});

	it("gives nothing for nothing", () => {
		expect(groupNoneFit([])).toEqual([]);
	});
});
describe("shared Maybe parts", () => {
	it("renders both new-category and below-threshold category row tags", async () => {
		const { MaybeCategory } = await import("../src/views/maybe-category");
		const { renderToString } = await import("hono/jsx/dom/server");
		expect(
			renderToString(MaybeCategory({ name: "Pet Care", kind: "new" })),
		).toContain("Maybe new: Pet Care");
		expect(
			renderToString(MaybeCategory({ name: "Eating Out", kind: "category" })),
		).toContain("Maybe Eating Out");
	});
	it("renders the first dashed category chip as Suggested with Tally's confidence", async () => {
		const { SuggestedCategoryChip } = await import(
			"../src/views/maybe-category"
		);
		const { renderToString } = await import("hono/jsx/dom/server");
		const html = renderToString(
			SuggestedCategoryChip({
				name: "Eating Out",
				value: "2",
				sure: 64,
				transactionId: 1,
			}),
		);
		expect(html).toContain("Suggested");
		expect(html).toContain("Tally&#39;s guess · 64% sure");
		expect(html).toContain("border-dashed");
		expect(html).toContain("Tally&#39;s guess · 64% sure");
	});
	it("lists the shared Maybe parts in the design catalog", async () => {
		const res = await designSystem.request(
			"/design-system",
			{},
			{ ...env, DEMO: "true" },
		);
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).toContain(
			'data-ds-components="MaybeCategory SuggestedCategoryChip"',
		);
		const confidenceIds = [
			...html.matchAll(/<span class="sr-only" id="([^"]+)">Tally&#39;s guess/g),
		].map((match) => match[1]);
		expect(confidenceIds).toHaveLength(2);
		expect(new Set(confidenceIds).size).toBe(2);
		for (const id of confidenceIds) {
			expect(html).toContain(`aria-describedby="${id}"`);
		}
	});
});
