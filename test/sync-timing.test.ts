import { describe, expect, it } from "vitest";
import {
	SYNC_COOLDOWN_SECONDS,
	SYNC_LEASE_MINUTES,
	SYNC_RUN_BUDGET_MS,
} from "../src/plaid/timing";

// How long a sync holds a bank, how soon the same bank may sync again, and how long one run may take are written once, in
// src/plaid/timing.ts (audit finding). Two copies of a lease length drift: a renewal shorter than the first claim.

// The two files that take, renew and pace a sync. (Other files in src/plaid have their own, unrelated times, such as how long
// a webhook key is kept.)
const OTHERS = Object.entries(
	import.meta.glob("../src/plaid/{sync,sync-all}.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>,
);

describe("the sync timing numbers", () => {
	it("are positive whole numbers", () => {
		for (const n of [
			SYNC_LEASE_MINUTES,
			SYNC_COOLDOWN_SECONDS,
			SYNC_RUN_BUDGET_MS,
		])
			expect(Number.isInteger(n) && n > 0).toBe(true);
	});

	it("are not spelled out again in src/plaid: no lease, cooldown or run-budget literal in the sync files", () => {
		const offenders: string[] = [];
		for (const [file, text] of OTHERS)
			for (const line of text.split("\n")) {
				if (/^\s*(?:\/\/|\/?\*)/.test(line)) continue;
				if (
					/datetime\('now', '[+-]\d+ (?:minutes?|seconds?)'\)/.test(line) ||
					/\b\d+ \* 60 \* 1000\b/.test(line)
				)
					offenders.push(
						`${file.replace("../", "")}: ${line.trim().slice(0, 90)}`,
					);
			}
		expect(offenders).toEqual([]);
	});
});
