import { describe, expect, it } from "vitest";
import {
	APPLE_STALE_AFTER_DAYS,
	appleCardNotice,
} from "../src/apple-card/stale";
import type { AppleCardAccount } from "../src/db/accounts";

// Home's Apple Card reminder (spec §8.10, decision 138): seven household days after the last upload, counted from the
// upload, never from the last charge; nothing once removed or before a first upload.

const TODAY = "2026-10-19";

const card = (overrides: Partial<AppleCardAccount> = {}): AppleCardAccount => ({
	id: 1,
	balanceCents: 124000,
	balanceOn: "2026-10-12",
	uploadedOn: "2026-10-12",
	removedAt: null,
	countedFrom: "2026-07-21",
	through: "2026-10-11",
	...overrides,
});

describe("appleCardNotice", () => {
	it("waits 7 days", () => {
		expect(APPLE_STALE_AFTER_DAYS).toBe(7);
	});

	it("says the card hasn't been updated since its last upload, once 7 days have passed", () => {
		expect(appleCardNotice(card(), TODAY)).toEqual({
			words: "Apple Card hasn't been updated since Oct 12",
			since: "2026-10-12",
		});
	});

	it("is not shown at 6 days", () => {
		expect(
			appleCardNotice(card({ uploadedOn: "2026-10-13" }), TODAY),
		).toBeNull();
	});

	it("is not shown once removed", () => {
		expect(
			appleCardNotice(card({ removedAt: "2026-10-14 09:00:00" }), TODAY),
		).toBeNull();
	});

	it("is not shown before a first upload, or with no card", () => {
		expect(appleCardNotice(card({ uploadedOn: null }), TODAY)).toBeNull();
		expect(appleCardNotice(null, TODAY)).toBeNull();
	});

	it("names the year when the upload is from another year", () => {
		expect(
			appleCardNotice(card({ uploadedOn: "2025-12-30" }), "2026-01-08"),
		).toEqual({
			words: "Apple Card hasn't been updated since Dec 30, 2025",
			since: "2025-12-30",
		});
	});

	it("is not shown for an upload dated after today", () => {
		expect(
			appleCardNotice(card({ uploadedOn: "2026-10-25" }), TODAY),
		).toBeNull();
	});
});
