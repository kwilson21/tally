import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDemo } from "../src/demo/reset";
import { present } from "./helpers/present";

// The store lookup's answers (spec §5, migration 0078): one row per transaction Jev was asked about with the line,
// and the `with_line` flag each Maybe answer records. Nothing writes lookup_answers until part B, so the rows here
// are inserted by hand.

const db = env.DB;
const BASE = "http://tally.test";

/** A posted purchase on a non-cash account, with no category set. */
const purchase = async (raw = "LOOKUP ANSWERS") =>
	present(
		await db
			.prepare(
				`INSERT INTO transactions (account_id, date, amount_cents, raw_name)
				VALUES ((SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', 2300, ?)
				RETURNING id`,
			)
			.bind(raw)
			.first<{ id: number }>(),
	).id;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

describe("lookup_answers (migration 0078)", () => {
	it("holds one row per transaction: a second row for the same transaction is refused", async () => {
		const id = await purchase();

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'LUPITAS', 0)",
			)
			.bind(id)
			.run();

		await expect(
			db
				.prepare(
					"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'LUPITAS', 1)",
				)
				.bind(id)
				.run(),
		).rejects.toThrow();
	});

	it("refuses kept values other than 0 or 1", async () => {
		const id = await purchase();

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'LUPITAS', 0)",
			)
			.bind(id)
			.run();
		await db.prepare("DELETE FROM lookup_answers").run();

		await expect(
			db
				.prepare(
					"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'LUPITAS', 2)",
				)
				.bind(id)
				.run(),
		).rejects.toThrow();
	});

	it("is deleted with its transaction (ON DELETE CASCADE)", async () => {
		const id = await purchase();

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'LUPITAS', 0)",
			)
			.bind(id)
			.run();
		await db.prepare("DELETE FROM transactions WHERE id = ?").bind(id).run();

		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS n FROM lookup_answers WHERE transaction_id = ?",
				)
				.bind(id)
				.first<{ n: number }>(),
		).toEqual({ n: 0 });
	});
});

describe("maybe_answers.with_line (migration 0078)", () => {
	it("reads 0 when an insert leaves it out, as migration 0062's inserts do", async () => {
		await db
			.prepare(
				"INSERT INTO maybe_answers (kind, confidence, answer, household_day) VALUES ('category', 0.5, 'yes', '2026-10-03')",
			)
			.run();

		expect(
			await db
				.prepare("SELECT with_line AS withLine FROM maybe_answers")
				.first<{ withLine: number }>(),
		).toEqual({ withLine: 0 });
	});

	it("refuses values other than 0 or 1", async () => {
		await db
			.prepare(
				"INSERT INTO maybe_answers (kind, confidence, answer, household_day, with_line) VALUES ('category', 0.5, 'yes', '2026-10-03', 1)",
			)
			.run();

		await expect(
			db
				.prepare(
					"INSERT INTO maybe_answers (kind, confidence, answer, household_day, with_line) VALUES ('category', 0.5, 'yes', '2026-10-03', 2)",
				)
				.run(),
		).rejects.toThrow();
	});
});

describe("reset and export", () => {
	it("the demo reset empties lookup_answers", async () => {
		const id = await purchase();

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept) VALUES (?, 'LUPITAS', 0)",
			)
			.bind(id)
			.run();
		await resetDemo(db, "2026-09-22");

		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM lookup_answers")
				.first<{ n: number }>(),
		).toEqual({ n: 0 });
	});

	it("the JSON export holds every lookup_answers column and maybe_answers' with_line", async () => {
		const id = await purchase();

		await db
			.prepare(
				"INSERT INTO lookup_answers (transaction_id, lookup_text, kept, kept_category_id, kept_confidence) VALUES (?, 'LUPITAS', 1, NULL, 0.95)",
			)
			.bind(id)
			.run();
		await db
			.prepare(
				"INSERT INTO maybe_answers (kind, confidence, answer, household_day, with_line) VALUES ('category', 0.95, 'yes', '2026-10-03', 1)",
			)
			.run();

		const body = await (
			await exports.default.fetch(`${BASE}/settings/export/tally.json`)
		).text();

		// SAFETY: the export is the JSON this route writes, so each table is an array of its rows.
		const data = JSON.parse(body) as Record<string, unknown[]>;

		expect(data.lookup_answers).toContainEqual({
			transaction_id: id,
			lookup_text: "LUPITAS",
			kept: 1,
			kept_category_id: null,
			kept_confidence: 0.95,
		});
		expect(data.maybe_answers).toContainEqual(
			expect.objectContaining({ kind: "category", with_line: 1 }),
		);
	});
});
