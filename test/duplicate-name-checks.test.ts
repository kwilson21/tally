import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { JEV_THRESHOLD } from "../src/ai/categorize";
import { addCategory, makeCategory } from "../src/db/categories";
import {
	createFromSuggestion,
	saveSuggestion,
} from "../src/db/category-suggestions";
import { resetDemo } from "../src/demo/reset";
import { nameTaken } from "../src/routes/settings";
import { member } from "./helpers/member";

// Four places recognise a duplicate name from the database's refusal: saveSuggestion's catch, createFromSuggestion's
// catch, makeCategory and settings' nameTaken. Each recognises a plain driver error and a Drizzle-wrapped one ("Failed
// query" with the driver's error as cause), and rethrows anything else. SQLite words the refusal in capitals.

const db = env.DB;
const CHECKING = 1;

/** A duplicate refused as the driver words it, and as Drizzle wraps it. */
const uniqueErrors: [string, Error][] = [
	[
		"a driver error",
		new Error("D1_ERROR: UNIQUE constraint failed: category_suggestions.name"),
	],
	[
		"a Drizzle-wrapped error",
		new Error("Failed query: INSERT INTO category_suggestions (name, status)", {
			cause: new Error(
				"D1_ERROR: UNIQUE constraint failed: category_suggestions.name",
			),
		}),
	],
];

/** A suggestion the setup saved: a null here means the setup broke, so the test fails at once. */
function savedId(id: number | null): number {
	if (id === null)
		throw new Error("the test's setup did not save a suggestion");

	return id;
}

/** Another member's write, run before the refused batch. */
type Write = () => Promise<D1Result>;

/** The database, except that its batch first runs `between`, then is refused with `error`, as a duplicate would refuse it. */
function failingBatch(error: Error, ...between: Write[]) {
	return new Proxy(db, {
		get(target, property) {
			if (property === "batch")
				return async () => {
					for (const write of between) await write();

					throw error;
				};

			return member(target, property);
		},
	});
}

/** The database, except that a category insert is refused with `error` when it runs, as a duplicate name would be. */
function failingCategoryInsert(error: Error) {
	const refused = (statement: D1PreparedStatement) =>
		new Proxy(statement, {
			get(target, property) {
				if (property === "bind")
					return (...values: unknown[]) => refused(target.bind(...values));

				if (property === "run")
					return async () => {
						throw error;
					};

				return member(target, property);
			},
		});

	return new Proxy(db, {
		get(target, property) {
			if (property === "prepare")
				return (sql: string) => {
					const statement = target.prepare(sql);

					return sql.startsWith("INSERT INTO categories")
						? refused(statement)
						: statement;
				};

			return member(target, property);
		},
	});
}

/** Another save filed the same name first, between a read and the batch that would have filed it. */
const rivalInsert = () =>
	db
		.prepare(
			"INSERT INTO category_suggestions (name, status) VALUES ('Subscriptions', 'pending')",
		)
		.run();

/** One transaction a suggestion can file: a confident none-fit for ENTERTAINMENT. */
async function add(rawName: string, date: string): Promise<number> {
	const result = await db
		.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_category,
				category_confidence, jev_none_fit, excluded, flag_income, is_split, parent_id, pending)
			 VALUES (?, ?, 1500, ?, 'ENTERTAINMENT', ?, 1, 0, 0, 0, NULL, 0)`,
		)
		.bind(CHECKING, date, rawName, JEV_THRESHOLD)
		.run();

	return Number(result.meta.last_row_id);
}

/** Three purchases a suggestion can file: saveSuggestion files nothing with fewer than three eligible ones. */
const threePurchases = async () => [
	await add("NETFLIX.COM", "2026-09-20"),
	await add("HULU", "2026-09-21"),
	await add("SPOTIFY", "2026-09-22"),
];

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
});

describe("a duplicate name refused by a suggestion's batch", () => {
	it.each(uniqueErrors)(
		"saveSuggestion attaches the purchases to the pending row a rival filed, on %s",
		async (_kind, error) => {
			const made = [
				await add("NETFLIX.COM", "2026-09-20"),
				await add("HULU", "2026-09-21"),
				await add("SPOTIFY", "2026-09-22"),
			];

			const id = await saveSuggestion(
				failingBatch(error, rivalInsert),
				"Subscriptions",
				made,
			);

			const rows = await db
				.prepare(
					"SELECT id FROM category_suggestions WHERE name = 'Subscriptions' AND status = 'pending'",
				)
				.all<{ id: number }>();

			expect(rows.results).toEqual([{ id }]);
		},
	);

	it("saveSuggestion rethrows an error that is not a duplicate name", async () => {
		const made = await threePurchases();

		await expect(
			saveSuggestion(
				failingBatch(new Error("no such table: merchants")),
				"Subscriptions",
				made,
			),
		).rejects.toThrow("no such table: merchants");
	});

	it.each(uniqueErrors)(
		"createFromSuggestion says the name is taken, on %s",
		async (_kind, error) => {
			const made = await threePurchases();
			const id = savedId(await saveSuggestion(db, "Subscriptions", made));

			expect(
				await createFromSuggestion(
					failingBatch(error),
					id,
					{ ticked: made, shown: made, notes: {} },
					"person",
				),
			).toEqual({ ok: false, reason: "invalid", error: "That name is taken." });
		},
	);

	it("createFromSuggestion rethrows an error that is not a duplicate name", async () => {
		const made = await threePurchases();
		const id = savedId(await saveSuggestion(db, "Subscriptions", made));

		await expect(
			createFromSuggestion(
				failingBatch(new Error("no such table: merchants")),
				id,
				{ ticked: made, shown: made, notes: {} },
				"person",
			),
		).rejects.toThrow("no such table: merchants");
	});
});

describe("a duplicate name refused by makeCategory's insert", () => {
	beforeEach(async () => {
		await addCategory(db, { name: "Zebra Care" });
	});

	it.each(uniqueErrors)(
		"says the name is taken, on %s",
		async (_kind, error) => {
			expect(
				await makeCategory(failingCategoryInsert(error), {
					name: "Zebra Care",
				}),
			).toEqual({ ok: false, error: "That name is taken." });
		},
	);

	it("rethrows an error that is not a duplicate name", async () => {
		await expect(
			makeCategory(
				failingCategoryInsert(new Error("no such table: categories")),
				{ name: "Zebra Care" },
			),
		).rejects.toThrow("no such table: categories");
	});
});

describe("settings' nameTaken", () => {
	it("recognises a driver error and a Drizzle-wrapped one, by the UNIQUE text", () => {
		for (const [, error] of uniqueErrors) expect(nameTaken(error)).toBe(true);
	});

	it("recognises the refusal SQLite itself raises for a second pending name", async () => {
		await rivalInsert();

		const refusal = await rivalInsert().then(
			() => null,
			(error: Error) => error,
		);

		expect(refusal).toBeInstanceOf(Error);
		expect(nameTaken(refusal)).toBe(true);
	});

	it("is case-sensitive, as SQLite words the refusal in capitals, and rejects anything else", () => {
		expect(nameTaken(new Error("unique constraint failed"))).toBe(false);
		expect(nameTaken(new Error("no such table: people"))).toBe(false);
		expect(nameTaken("UNIQUE constraint failed")).toBe(false);
	});
});
