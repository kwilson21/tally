// The re-sort's clusters (decision 158, decision 160): the rows a re-sort asks Jev about once, so a group of rows that
// share a cleaned bank text gets one answer. Pure: the caller loads the rows, and nothing here calls Jev or AI.
//
// The rules, each a test in test/resort-clusters.test.ts:
// - rows group by groupBySameCleanedText (same cleaned text; a mixed row never groups; a vague text only with the
//   same note; a row whose text cleans to nothing never groups);
// - a cluster's first row is its leader. A row joins only if its sign matches the leader's and, on the absolute
//   amounts in integer cents with lo and hi the smaller and larger of the two, hi <= 2 * lo or hi - lo < $10. A row
//   that fails becomes a singleton cluster, in input order;
// - a cluster holds at most CLUSTER_MAX rows. A bigger one is split into chunks of CLUSTER_MAX, each with its own
//   leader (its first row), and the amount rule is applied again inside each chunk against that chunk's leader;
// - every input row appears in exactly one cluster; a row no group holds is a singleton.

import { groupBySameCleanedText, type SameTextRow } from "./same-text-matches";

/** The most rows one cluster (one Jev question) may hold. */
export const CLUSTER_MAX = 25;

/** The amounts within this many cents of each other always join (decision 160: $10). */
const NEAR_CENTS = 1000;

/** A row the clusters are built from: the same-text fields plus its amount in integer cents (Plaid's sign). */
export type ClusterRow = SameTextRow & { amountCents: number };

/** True when `row` may join the cluster `leader` leads, by sign and amount (decision 160). */
export function joinsLeader(
	leader: Pick<ClusterRow, "amountCents">,
	row: Pick<ClusterRow, "amountCents">,
): boolean {
	if (Math.sign(leader.amountCents) !== Math.sign(row.amountCents))
		return false;
	const a = Math.abs(leader.amountCents);
	const b = Math.abs(row.amountCents);
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);

	return hi <= 2 * lo || hi - lo < NEAR_CENTS;
}

/**
 * The clusters of row ids, each leader first, in the order their leaders appear in `rows`. Every input row appears in
 * exactly one cluster.
 */
export function buildClusters<T extends ClusterRow>(
	rows: readonly T[],
): number[][] {
	const position = new Map<number, number>();
	rows.forEach((row, index) => {
		position.set(row.id, index);
	});

	const clusters: number[][] = [];
	const held = new Set<number>();

	for (const group of groupBySameCleanedText(rows)) {
		const [leader, ...others] = group.rows as T[];

		if (!leader) continue;
		// The rows that pass the rule against the group's leader, in input order. The leader is first.
		const passing: T[] = [leader];

		for (const row of others) {
			if (joinsLeader(leader, row)) passing.push(row);
			else clusters.push([row.id]);
		}

		for (const chunk of chunkClusters(passing)) clusters.push(chunk);

		for (const row of group.rows) held.add(row.id);
	}

	// A row no group holds (a group of one, a mixed row, blank text, a vague text without a note) is its own cluster.
	for (const row of rows) if (!held.has(row.id)) clusters.push([row.id]);

	const at = (cluster: number[]) => position.get(cluster[0] ?? -1) ?? 0;

	return clusters.sort((a, b) => at(a) - at(b));
}

/**
 * Splits rows that already share a text into chunks of CLUSTER_MAX. Each chunk takes its own first row as leader, and
 * a row that fails the rule against that leader becomes a singleton. Returns the clusters as id lists.
 */
function chunkClusters<T extends ClusterRow>(rows: readonly T[]): number[][] {
	const out: number[][] = [];

	for (let start = 0; start < rows.length; start += CLUSTER_MAX) {
		const [leader, ...others] = rows.slice(start, start + CLUSTER_MAX);

		if (!leader) continue;
		const members = [leader.id];

		for (const row of others) {
			if (joinsLeader(leader, row)) members.push(row.id);
			else out.push([row.id]);
		}

		out.push(members);
	}

	return out;
}
