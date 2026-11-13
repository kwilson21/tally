import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { includedSql, isIncluded } from "../src/db/counted-month";

// isIncluded (TypeScript) and includedSql (SQL) say the same thing about a row: not excluded, or paying a bill or a plan.
// The comment on isIncluded asks to keep them in step; this is the test that keeps it, over every case there is.
describe("isIncluded agrees with includedSql", () => {
	it.each([
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	])("excluded=%s, pays a bill or plan=%s", async (excluded, pays) => {
		const row = await env.DB.prepare(
			`SELECT ${includedSql("t", pays ? "1" : "0")} AS included FROM (SELECT ? AS excluded) t`,
		)
			.bind(excluded ? 1 : 0)
			.first<{ included: number }>();

		expect(row?.included === 1).toBe(isIncluded(excluded, pays));
	});
});
