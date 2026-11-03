import { describe, expect, it } from "vitest";
import { displayName, learnedLines } from "../src/db/learned-lines";

// A learned line's name is its cleaned bank text, title-cased for people: every word capitalised except the small
// words (of, the, and, a, an, in, at, to, for, on), which stay lower case unless they open the name.

describe("displayName: a line's name for people", () => {
	it.each([
		["museum of the bible", "Museum of the Bible"],
		["netflix.com", "Netflix.com"],
		["audible", "Audible"],
		["apple.com/bill", "Apple.com/bill"],
		["kindle unltd", "Kindle Unltd"],
		["amazon mktplace pmts", "Amazon Mktplace Pmts"],
		["bank of america", "Bank of America"],
		["a and b", "A and B"],
		["to the point", "To the Point"],
	])("shows %s as %s", (cleaned, name) => {
		expect(displayName(cleaned)).toBe(name);
	});

	it("is what a line shows, from its own cleaned text", () => {
		const [line] = learnedLines([
			{
				id: 1,
				date: "2026-10-02",
				rawName: "MUSEUM OF THE BIBLE WASHINGTON DC 08/04",
				updatedAt: "2026-10-02 12:00:00",
				categoryId: 11,
				categoryName: "Entertainment",
				icon: "entertainment",
				color: "cat-blue",
			},
		]);
		expect(line?.name).toBe("Museum of the Bible Washington");
	});
});
