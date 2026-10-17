// The fifth day's sentence (P125 E, #586): what the overnight run did, in words, with the counts in thousands.
import { describe, expect, it } from "vitest";
import { nightSentence } from "../src/views/home-setup";

describe("the fifth day's sentence (P125 E, #586)", () => {
	it.each([
		[
			{ brought: 3, needYou: 0 },
			"Five. Overnight Tally kept count on its own: 3 new transactions, all sorted. You're set up.",
		],
		[
			{ brought: 1, needYou: 0 },
			"Five. Overnight Tally kept count on its own: 1 new transaction, all sorted. You're set up.",
		],
		[
			{ brought: 0, needYou: 0 },
			"Five. Overnight Tally kept count on its own: no new transactions, all sorted. You're set up.",
		],
		[
			{ brought: 3, needYou: 1 },
			"Five. Overnight Tally kept count on its own: 3 new transactions; 1 needs you.",
		],
		[
			{ brought: 3, needYou: 2 },
			"Five. Overnight Tally kept count on its own: 3 new transactions; 2 need you.",
		],
		[
			{ brought: 0, needYou: 1 },
			"Five. Overnight Tally kept count on its own: no new transactions; 1 needs you.",
		],
		[
			{ brought: 1234, needYou: 1500 },
			"Five. Overnight Tally kept count on its own: 1,234 new transactions; 1,500 need you.",
		],
	])("says %j", (night, sentence) => {
		expect(nightSentence(night)).toBe(sentence);
	});
});
