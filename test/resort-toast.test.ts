import { describe, expect, it } from "vitest";
import { closingToast, undoWords } from "../src/resort-toast";

// The closing toast's and Undo's words (decision 160): one destination, several, nothing moved, pluralisation, and the
// one case with no toast at all.

describe("the closing toast (decision 160)", () => {
	it("names the one destination when every moved row went to it", () => {
		expect(
			closingToast({
				moved: 14,
				needAnswer: 3,
				byCategory: [{ name: "Books & audio", count: 14 }],
			}),
		).toEqual({
			message: "Moved 14 to Books & audio. 3 need your answer.",
			type: "success",
			undo: true,
		});
	});

	it("counts rows when they went to several categories", () => {
		expect(
			closingToast({
				moved: 14,
				needAnswer: 3,
				byCategory: [
					{ name: "Books & audio", count: 9 },
					{ name: "Gifts", count: 5 },
				],
			})?.message,
		).toBe("Moved 14 rows. 3 need your answer.");
	});

	it("says nothing moved when only some rows wait", () => {
		expect(closingToast({ moved: 0, needAnswer: 3, byCategory: [] })).toEqual({
			message: "Nothing moved. 3 need your answer.",
			type: "info",
			undo: false,
		});
	});

	it("has no toast when nothing moved and nothing waits", () => {
		expect(
			closingToast({ moved: 0, needAnswer: 0, byCategory: [] }),
		).toBeNull();
	});

	it("drops the answer clause when nothing waits", () => {
		expect(
			closingToast({
				moved: 2,
				needAnswer: 0,
				byCategory: [{ name: "Gifts", count: 2 }],
			})?.message,
		).toBe("Moved 2 to Gifts.");
	});

	it("pluralises one moved row and one waiting row", () => {
		expect(
			closingToast({
				moved: 1,
				needAnswer: 1,
				byCategory: [{ name: "Books & audio", count: 1 }],
			})?.message,
		).toBe("Moved 1 to Books & audio. 1 needs your answer.");
		expect(
			closingToast({
				moved: 1,
				needAnswer: 2,
				byCategory: [
					{ name: "Books & audio", count: 1 },
					{ name: "Gifts", count: 0 },
				],
			})?.message,
		).toBe("Moved 1 row. 2 need your answer.");
	});
});

describe("the Undo answer (decision 160)", () => {
	it("says the rows went back", () => {
		expect(
			undoWords({ expired: false, restored: 14, changedSince: 0 }),
		).toEqual({
			message: "Put 14 back.",
			type: "success",
		});
	});

	it("says which rows changed since and stayed", () => {
		expect(
			undoWords({ expired: false, restored: 12, changedSince: 2 }).message,
		).toBe("Put 12 back. 2 changed since, so they stayed.");
		expect(
			undoWords({ expired: false, restored: 11, changedSince: 1 }).message,
		).toBe("Put 11 back. 1 changed since, so it stayed.");
	});

	it("says nothing went back when every row changed since", () => {
		expect(undoWords({ expired: false, restored: 0, changedSince: 2 })).toEqual(
			{
				message: "Nothing put back. 2 changed since, so they stayed.",
				type: "info",
			},
		);
	});

	it("is an error once the ten seconds have passed", () => {
		expect(undoWords({ expired: true, restored: 0, changedSince: 0 })).toEqual({
			message: "Too late to undo that.",
			type: "error",
		});
	});
});
