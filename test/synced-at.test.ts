import { describe, expect, it } from "vitest";
import { syncedAtLabel } from "../src/synced-at";

const now = new Date("2026-09-28T12:00:00Z");

describe("syncedAtLabel", () => {
	it.each([
		[null, "Not synced yet"],
		["2026-09-28 11:59:01", "Synced just now"],
		["2026-09-28 11:48:00", "Synced 12 minutes ago"],
		["2026-09-28 10:00:00", "Synced 2 hours ago"],
		["2026-09-27 10:00:00", "Synced yesterday"],
		["2026-09-25 10:00:00", "Synced Sep 25, 2026"],
	])("words %s as %s", (value, expected) => {
		expect(syncedAtLabel(value, now)).toBe(expected);
	});
});
