import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askAgain, askAgainMany } from "../src/categorize-pending";
import { resetDemo } from "../src/demo/reset";
import { sortAfterSync } from "../src/plaid/sort-after-sync";
import { recordSorting } from "./record-sorting";

const db = env.DB;
const TODAY = "2026-09-22";

const sortEnv = (withKey = true) => ({
	DB: db,
	SORT: env.SORT,
	JEV_API_KEY: withKey ? "test-key" : undefined,
});

// Each daytime trigger's one `create`, recorded without a real instance (test/record-sorting.ts).
const create = recordSorting();

beforeEach(async () => {
	await resetDemo(db, TODAY);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const ids = (n: number, from = 1) =>
	Array.from({ length: n }, (_, i) => from + i);

describe("a sync hands all of its rows to one Workflow instance", () => {
	it("80 changed rows make one create with all 80, sorted as a sync's", async () => {
		await sortAfterSync(
			sortEnv(),
			{ changedIds: ids(80) },
			{ rulesApplied: true },
		);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith({
			params: { ids: ids(80), bySync: true, rulesApplied: true },
		});
	});

	it("3,000 changed rows are still one create, and its params stay under 1 MiB", async () => {
		await sortAfterSync(sortEnv(), { changedIds: ids(3000) });
		expect(create).toHaveBeenCalledTimes(1);
		const params = (create.mock.calls[0] as unknown as [{ params: unknown }])[0]
			.params;
		expect(JSON.stringify(params).length).toBeLessThan(1_048_576);
	});

	it("with no Jev key, or no changed rows, nothing is started", async () => {
		await sortAfterSync(sortEnv(false), { changedIds: ids(5) });
		await sortAfterSync(sortEnv(), { changedIds: [] });
		expect(create).not.toHaveBeenCalled();
	});
});

describe("ask again hands its rows to one Workflow instance, with no cap", () => {
	it("clears the left-out marks and makes one create with every id, bySync off", async () => {
		// Three unsorted rows that Jev was unsure of: the marks that keep them from being asked.
		const rows = (
			await db.batch(
				Array.from({ length: 3 }, (_, i) =>
					db
						.prepare(
							"INSERT INTO transactions(account_id,date,amount_cents,raw_name,category_confidence) VALUES(1,?,-500,?,0.2) RETURNING id",
						)
						.bind(TODAY, `AGAIN ${i}`),
				),
			)
		).map((result) => Number((result.results[0] as { id: number }).id));
		await askAgainMany(sortEnv(), rows);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith({
			params: { ids: rows, bySync: false, rulesApplied: false },
		});
		const marked = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE id IN (SELECT value FROM json_each(?)) AND category_confidence IS NOT NULL",
			)
			.bind(JSON.stringify(rows))
			.first<{ n: number }>();
		expect(marked?.n).toBe(0);
	});

	it("ask again for one row passes that one id", async () => {
		await askAgain({ ...sortEnv() }, 7);
		expect(create).toHaveBeenCalledWith({
			params: { ids: [7], bySync: false, rulesApplied: false },
		});
	});
});

describe("a create that fails", () => {
	it("is logged by its error name only, and the request still succeeds", async () => {
		create.mockRejectedValueOnce(new TypeError("secret transaction text"));
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			sortAfterSync(sortEnv(), { changedIds: ids(3) }),
		).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalledWith("sorting: couldn't start TypeError");
		expect(JSON.stringify(logged.mock.calls)).not.toContain(
			"secret transaction text",
		);
	});
});
