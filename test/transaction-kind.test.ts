import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TRANSACTION_KINDS } from "../src/transactions/kind";

describe("transaction kinds", () => {
	it("are exactly the kinds the database allows in transactions.kind", async () => {
		const row = await env.DB.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'",
		).first<{ sql: string }>();

		const check = row?.sql.match(
			/\bkind\s+TEXT\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/i,
		);

		expect(check, "transactions.kind has no CHECK").not.toBeNull();

		const allowed = [...(check?.[1] ?? "").matchAll(/'([^']+)'/g)].map(
			(m) => m[1],
		);

		expect([...allowed].sort()).toEqual([...TRANSACTION_KINDS].sort());
	});
});
