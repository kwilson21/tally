import { describe, expect, it } from "vitest";
import {
	groupNoneFit,
	MAX_MERCHANTS_SENT,
	MIN_GROUP,
	type NoneFit,
} from "../src/category-suggestions";

// New category suggestions (spec §7, #51): code groups the transactions Jev was sure no category fit,
// and only a group of several asks Workers AI for a name. A single Venmo payment never does.

let n = 0;
const row = (theme: string, merchant: string, key = merchant): NoneFit => {
	n += 1;
	return { id: n, theme, merchant, merchantKey: key };
};

describe("groupNoneFit", () => {
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
