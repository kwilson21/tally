import { describe, expect, it } from "vitest";
import decisions from "../docs/decisions.md?raw";

// The decisions table's rows are "| # | Date | Decision | Why |": four cells, each split by a bar.
const cellsOf = (row: string) =>
	row
		.split("|")
		.slice(1, -1)
		.map((cell) => cell.trim());

describe("docs/decisions.md's table format", () => {
	it("gives decision 146's row the table's four cells: number, date, decision and why (#762)", () => {
		const row =
			decisions.split("\n").find((line) => line.startsWith("| 146 | ")) ?? "";
		const cells = cellsOf(row);
		expect(cells).toHaveLength(4);
		expect(cells[0]).toBe("146");
		expect(cells[1]).toBe("2026-10-21");
		expect(cells[2].endsWith("for the first week only.")).toBe(true);
		expect(
			cells[3].startsWith("**Why.** The owner's production first week"),
		).toBe(true);
	});
});
