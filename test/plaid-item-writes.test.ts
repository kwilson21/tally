import { describe, expect, it } from "vitest";

// Only src/plaid/item-store.ts may write plaid_items.status or disconnected_at. This reads every source file as text
// (Vite's raw import) and fails on a SET clause that names either column in any other file.
const sources = import.meta.glob("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const STORE = "../src/plaid/item-store.ts";

/** The SET part of each `UPDATE plaid_items SET ...` in the text: from SET up to WHERE, or to the end of the statement. */
function setClauses(text: string): string[] {
	return [...text.matchAll(/UPDATE\s+plaid_items\s+SET\b([^`"';]*)/gi)].map(
		(match) => (match[1] ?? "").split(/\bWHERE\b/i)[0] ?? "",
	);
}

/** Whether a SET clause assigns status or disconnected_at (a WHERE comparison such as `status = ?` is not a write). */
function writesProtectedColumn(setClause: string): boolean {
	return /\b(status|disconnected_at)\s*=/.test(setClause);
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

	it("reads the store's own SQL, so the scan is not empty", () => {
		expect(setClauses(sources[STORE] ?? "").length).toBeGreaterThan(0);
	});

	it("no file under src/ outside the store writes plaid_items.status or disconnected_at", () => {
		const offenders = Object.entries(sources)
			.filter(([path]) => path !== STORE)
			.flatMap(([path, text]) =>
				setClauses(text)
					.filter(writesProtectedColumn)
					.map((clause) => `${path}: SET ${clause.trim()}`),
			);
		expect(offenders).toEqual([]);
	});
});
