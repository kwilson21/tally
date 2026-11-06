import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TABLES_CHILD_FIRST } from "../src/demo/reset";

// Tables resetDemo clears with its own statement rather than the delete list.
const CLEARED_ELSEWHERE = new Set(["household_settings"]);

async function appTables(): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
	).all<{ name: string }>();
	return results.map((row) => row.name);
}

describe("demo reset table list", () => {
	it("names every app table, so a new table is never left with old demo rows", async () => {
		const listed = new Set(TABLES_CHILD_FIRST);
		const missing = (await appTables()).filter(
			(name) => !listed.has(name) && !CLEARED_ELSEWHERE.has(name),
		);
		expect(missing).toEqual([]);
	});

	it("deletes each child table before the parent it references", async () => {
		const position = new Map(TABLES_CHILD_FIRST.map((name, i) => [name, i]));
		const problems: string[] = [];
		for (const child of TABLES_CHILD_FIRST) {
			const { results } = await env.DB.prepare(
				'SELECT "table" AS parent FROM pragma_foreign_key_list(?)',
			)
				.bind(child)
				.all<{ parent: string }>();
			for (const { parent } of results) {
				const childAt = position.get(child);
				const parentAt = position.get(parent);
				if (
					parentAt !== undefined &&
					childAt !== undefined &&
					parentAt < childAt
				)
					problems.push(`${child} must be deleted before ${parent}`);
			}
		}
		expect(problems).toEqual([]);
	});
});
