import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resetDemo, TABLES_CHILD_FIRST } from "../src/demo/reset";
import baseline from "./fixtures/demo-reset-baseline.json";

// Every row the demo reset writes, table by table, as the code before the statements were written with Drizzle
// recorded them (fixtures/demo-reset-baseline.json). The reset runs twice: from an empty database with no example,
// then again over those rows with the category example, after a household setting that must stay (jev_calls_*) and
// one that must go. A timestamp column (any `_at`) keeps its place as "<ts>" when it has a value, since datetime('now')
// is the clock; a column whose default is missing or changed still shows as null or a different value. The migration
// counter (d1_migrations in sqlite_sequence) is left out: it moves with every new migration, and the reset never writes it.

const db = env.DB;
const TODAY = "2026-10-15";
const TABLES = [...TABLES_CHILD_FIRST, "household_settings"];

type Row = Record<string, string | number | null>;

async function dump(): Promise<Record<string, Row[]>> {
	const out: Record<string, Row[]> = {};

	for (const table of TABLES) {
		const { results } = await db
			.prepare(`SELECT * FROM "${table}" ORDER BY rowid`)
			.all<Row>();

		out[table] = results.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([key, value]) => [
					key,
					key.endsWith("_at") && value !== null ? "<ts>" : value,
				]),
			),
		);
	}

	const { results: sequences } = await db
		.prepare(
			"SELECT name, seq FROM sqlite_sequence WHERE name <> 'd1_migrations' ORDER BY name",
		)
		.all<Row>();

	out.sqlite_sequence = sequences;

	return out;
}

describe("demo reset rows", () => {
	it("writes the same rows, in the same order and with the same defaults, as before", async () => {
		await resetDemo(db, TODAY);
		const plain = await dump();

		await db
			.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('jev_calls_2026-10-15', '3'), ('ai_switch_example', '0')",
			)
			.run();
		await resetDemo(db, TODAY, { categoryExample: true });
		const example = await dump();

		expect({ plain, example }).toEqual(baseline);
	});
});
