import { describe, expect, it } from "vitest";
import { syncedAtLabel } from "../src/synced-at";

const now = new Date("2026-09-28T12:00:00Z");

describe("syncedAtLabel", () => {
	it.each([
		[null, null],
		["2026-09-28 11:59:01", "Synced just now"],
		["2026-09-28 11:59:00", "Synced 1 minute ago"],
		["2026-09-28 11:01:00", "Synced 59 minutes ago"],
		["2026-09-28 11:00:00", "Synced 1 hour ago"],
		["2026-09-28 11:48:00", "Synced 12 minutes ago"],
		["2026-09-28 10:00:00", "Synced 2 hours ago"],
		["2026-09-27 13:00:00", "Synced 23 hours ago"],
		["2026-09-27 12:00:00", "Synced 1 day ago"],
		["2026-09-26 13:00:00", "Synced 1 day ago"],
		["2026-09-26 12:00:00", "Synced Sep 26, 2026"],
		["2026-09-25 10:00:00", "Synced Sep 25, 2026"],
	])("words %s as %s", (value, expected) => {
		expect(syncedAtLabel(value, now)).toBe(expected);
	});

	it("says nothing for a time it can't read", () => {
		expect(syncedAtLabel("not a time", now)).toBeNull();
	});
});
