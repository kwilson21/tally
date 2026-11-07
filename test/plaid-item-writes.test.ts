import { describe, expect, it } from "vitest";

// Only src/plaid/item-store.ts may write plaid_items.status or disconnected_at. This reads every source file as text
// (Vite's raw import) and fails on a SET clause that assigns either column in any other file.
const sources = import.meta.glob("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const STORE = "../src/plaid/item-store.ts";

// The table, bare, aliased (with or without AS), or quoted with double quotes or backticks. SET must follow it.
// The SET part runs to the end of the statement (a backtick or a semicolon) and is split at WHERE below.
const UPDATE_PLAID_ITEMS =
	/UPDATE\s+[`"]?plaid_items[`"]?(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b([^`;]*)/gi;

/** Blanks out the text of every single-quoted string, so a word inside quotes is never read as SQL. */
function withoutLiterals(text: string): string {
	return text.replace(/'(?:[^']|'')*'/g, "''");
}

/** The SET part of each UPDATE of plaid_items in the text: from SET up to WHERE, or to the end of the statement. */
function setClauses(text: string): string[] {
	return [...withoutLiterals(text).matchAll(UPDATE_PLAID_ITEMS)].map(
		(match) => (match[1] ?? "").split(/\bWHERE\b/i)[0] ?? "",
	);
}

/** Whether a SET clause assigns status or disconnected_at (a WHERE comparison such as `status = ?` is not a write). */
function writesProtectedColumn(setClause: string): boolean {
	return /\b(status|disconnected_at)\s*=/.test(setClause);
}

/** The SET clauses in the text that write a protected column. */
function protectedWrites(text: string): string[] {
	return setClauses(text).filter(writesProtectedColumn);
}

describe("the Plaid connection write guard", () => {
	it("flags a SET clause that assigns status or disconnected_at, and not one that only compares it", () => {
		expect(
			writesProtectedColumn("status = 'ok', reconnect_emailed_at = NULL "),
		).toBe(true);
		expect(
			writesProtectedColumn(
				"last_synced_at = datetime('now'),\n\t\t disconnected_at = datetime(",
			),
		).toBe(true);
		expect(writesProtectedColumn("reconnect_emailed_at = ? ")).toBe(false);
		expect(
			setClauses(
				"UPDATE plaid_items SET reconnect_emailed_at = ? WHERE id = ? AND status = 'needs_attention'",
			),
		).toEqual([" reconnect_emailed_at = ? "]);
	});

	it.each([
		[
			"a protected column after a quoted literal",
			"UPDATE plaid_items SET sync_cursor = 'abc', status = 'ok' WHERE id = 1",
		],
		[
			"a protected column on a later line",
			"UPDATE plaid_items SET sync_cursor = 'x',\n\t\t status = 'ok' WHERE id = 1",
		],
		[
			"an aliased table with AS",
			"UPDATE plaid_items AS p SET status = 'ok' WHERE p.id = 1",
		],
		[
			"an aliased table without AS",
			"UPDATE plaid_items p SET disconnected_at = datetime('now') WHERE p.id = 1",
		],
		[
			"a double-quoted table name",
			"UPDATE \"plaid_items\" SET status = 'ok' WHERE id = 1",
		],
		[
			"a backtick-quoted table name",
			"UPDATE `plaid_items` SET status = 'ok' WHERE id = 1",
		],
	])("flags %s", (_name, sql) => {
		expect(protectedWrites(sql)).toHaveLength(1);
	});

	it.each([
		[
			"a status word inside a quoted value",
			"UPDATE plaid_items SET last_synced_at = 'status = x' WHERE id = 1",
		],
		[
			"a status comparison in WHERE",
			"UPDATE plaid_items SET reconnect_emailed_at = ? WHERE id = ? AND status = 'needs_attention'",
		],
		[
			"an aliased write that only touches the reminder",
			"UPDATE plaid_items AS p SET reconnect_emailed_at = ? WHERE p.status = 'x'",
		],
	])("does not flag %s", (_name, sql) => {
		expect(protectedWrites(sql)).toEqual([]);
	});

	it("reads the store's own SQL, so the scan is not empty", () => {
		expect(setClauses(sources[STORE] ?? "").length).toBeGreaterThan(0);
	});

	it("no file under src/ outside the store writes plaid_items.status or disconnected_at", () => {
		const offenders = Object.entries(sources)
			.filter(([path]) => path !== STORE)
			.flatMap(([path, text]) =>
				protectedWrites(text).map((clause) => `${path}: SET ${clause.trim()}`),
			);
		expect(offenders).toEqual([]);
	});
});
