import { describe, expect, it } from "vitest";
import {
	buildClusters,
	CLUSTER_MAX,
	type ClusterRow,
} from "../src/resort-clusters";

// The re-sort's clusters (decision 158, decision 160): rows with the same cleaned bank text ask Jev once, so they
// form one cluster. A cluster's first row is its leader, and a row joins only when its sign matches and its amount
// is within twice the leader's or within $10 of it. Pure: no database, no Jev, no AI.

function row(
	id: number,
	rawName: string,
	extra: Partial<ClusterRow> = {},
): ClusterRow {
	return {
		id,
		rawName,
		merchantKey: rawName.toLowerCase(),
		amountCents: -1500,
		mixed: false,
		whatItWasNote: null,
		...extra,
	};
}

/** Every id that appears in the clusters, in order. */
const flat = (clusters: number[][]) => clusters.flat();

describe("buildClusters: same cleaned text", () => {
	it("groups rows with the same cleaned bank text, leader first", () => {
		const rows = [
			row(1, "CHECKCARD 0921 CVS"),
			row(2, "CHECKCARD 1002 CVS"),
			row(3, "SHELL OIL 5566"),
		];
		const clusters = buildClusters(rows);
		expect(clusters).toContainEqual([1, 2]);
		expect(clusters).toContainEqual([3]);
	});

	it("does not group rows from the same merchant with different bank text", () => {
		const rows = [
			row(1, "AMAZON MKTP US*KINDLE", { amountCents: -999 }),
			row(2, "AMAZON.COM AUDIBLE", { amountCents: -999 }),
		];
		expect(buildClusters(rows)).toEqual([[1], [2]]);
	});

	it("never groups a mixed row, even with the same text", () => {
		const rows = [
			row(1, "WHOLE FOODS MKT"),
			row(2, "WHOLE FOODS MKT", { mixed: true }),
		];
		expect(buildClusters(rows)).toEqual([[1], [2]]);
	});

	it("a vague text groups only with the same non-empty note", () => {
		const rows = [
			row(1, "APPLE.COM/BILL", { whatItWasNote: "iCloud" }),
			row(2, "APPLE.COM/BILL", { whatItWasNote: "iCloud" }),
			row(3, "APPLE.COM/BILL", { whatItWasNote: "Music" }),
			row(4, "APPLE.COM/BILL", { whatItWasNote: null }),
		];
		expect(buildClusters(rows)).toEqual([[1, 2], [3], [4]]);
	});
});

describe("buildClusters: the amount rule", () => {
	it("joins when the larger amount is at most twice the smaller (1500 and 2900)", () => {
		const rows = [
			row(1, "STORE A", { amountCents: -1500 }),
			row(2, "STORE A", { amountCents: -2900 }),
		];
		expect(buildClusters(rows)).toEqual([[1, 2]]);
	});

	it("splits when the larger is over twice the smaller and $10 or more apart (1500 and 3600)", () => {
		const rows = [
			row(1, "STORE A", { amountCents: -1500 }),
			row(2, "STORE A", { amountCents: -3600 }),
		];
		expect(buildClusters(rows)).toEqual([[1], [2]]);
	});

	it("joins when the difference is under $10 even past twice (400 and 1300)", () => {
		const rows = [
			row(1, "STORE A", { amountCents: -400 }),
			row(2, "STORE A", { amountCents: -1300 }),
		];
		expect(buildClusters(rows)).toEqual([[1, 2]]);
	});

	it("uses the leader as the reference for every row", () => {
		// 1500 leads. 2900 joins. 4000 is over 2 * 1500 and $10 or more above it, so it splits.
		const rows = [
			row(1, "STORE A", { amountCents: -1500 }),
			row(2, "STORE A", { amountCents: -2900 }),
			row(3, "STORE A", { amountCents: -4000 }),
		];
		expect(buildClusters(rows)).toEqual([[1, 2], [3]]);
	});

	it("never joins rows of opposite sign", () => {
		const rows = [
			row(1, "STORE A", { amountCents: -1500 }),
			row(2, "STORE A", { amountCents: 1500 }),
		];
		expect(buildClusters(rows)).toEqual([[1], [2]]);
	});

	it("compares absolute amounts, so a refund of the same size groups only with its own sign", () => {
		const rows = [
			row(1, "STORE A", { amountCents: -1500 }),
			row(2, "STORE A", { amountCents: -1200 }),
			row(3, "STORE A", { amountCents: 1200 }),
		];
		expect(buildClusters(rows)).toEqual([[1, 2], [3]]);
	});

	it("a row that fails the rule becomes its own singleton, in input order", () => {
		const rows = [
			row(7, "STORE A", { amountCents: -100 }),
			row(8, "STORE A", { amountCents: -5000 }),
			row(9, "STORE A", { amountCents: -110 }),
		];
		expect(buildClusters(rows)).toEqual([[7, 9], [8]]);
	});
});

describe("buildClusters: the cap and coverage", () => {
	it("exports a cap of 25", () => {
		expect(CLUSTER_MAX).toBe(25);
	});

	it("never returns a cluster over 25 rows, and each chunk has its own leader", () => {
		const rows = Array.from({ length: 60 }, (_, i) =>
			row(i + 1, "SAME STORE", { amountCents: -1500 }),
		);
		const clusters = buildClusters(rows);
		for (const cluster of clusters)
			expect(cluster.length).toBeLessThanOrEqual(25);
		expect(clusters.map((c) => c.length)).toEqual([25, 25, 10]);
		expect(clusters.map((c) => c[0])).toEqual([1, 26, 51]);
	});

	it("every input row appears in exactly one cluster", () => {
		const rows = [
			row(1, "CHECKCARD 0921 CVS", { amountCents: -1500 }),
			row(2, "CHECKCARD 1002 CVS", { amountCents: -2000 }),
			row(3, "APPLE.COM/BILL", { whatItWasNote: null }),
			row(4, "APPLE.COM/BILL", { whatItWasNote: "Music" }),
			row(5, "SHELL", { mixed: true }),
			row(6, "   ", { amountCents: -10 }),
			row(7, "SHELL", { amountCents: 900 }),
			row(8, "CHECKCARD 0001 CVS", { amountCents: -90000 }),
		];
		const clusters = buildClusters(rows);
		const ids = flat(clusters).sort((a, b) => a - b);
		expect(ids).toEqual(rows.map((r) => r.id).sort((a, b) => a - b));
	});

	it("returns no clusters for no rows", () => {
		expect(buildClusters([])).toEqual([]);
	});
});
