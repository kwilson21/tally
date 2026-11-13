import { describe, expect, it } from "vitest";

// Every file whose comments can ask a person to keep two things in step.
const SOURCES = import.meta.glob<string>(
	["../src/**/*.{ts,tsx}", "../public/js/*.js"],
	{ query: "?raw", import: "default", eager: true },
);

// A comment that says one thing must be kept in step with another is a promise only a person keeps.
// It is fine when a test keeps it instead, so the comment has to say which one: the word "test" in the same comment block.
const ASKS_TO_KEEP_IN_STEP =
	/keep (?:it|them|this|these|both)\b[^.]*\bin step|\bin step with\b|\b(?:SQL|plan) twin\b|\btwin of\b/i;

const NAMES_A_TEST = /\btests?\b|\.test\./i;

/** Each run of consecutive comment lines (`//`, `*`, `/**`) as one block, with its first line number. */
function commentBlocks(text: string): { line: number; text: string }[] {
	const blocks: { line: number; text: string }[] = [];
	let current: { line: number; text: string } | undefined;

	for (const [i, raw] of text.split("\n").entries()) {
		const isComment = /^\s*(\/\/|\/\*|\*)/.test(raw);

		if (isComment) {
			current ??= { line: i + 1, text: "" };
			current.text += `${raw}\n`;
		} else if (current) {
			blocks.push(current);
			current = undefined;
		}
	}

	if (current) blocks.push(current);

	return blocks;
}

/** The "file:line" of every comment block that asks to be kept in step but names no test. */
function untestedPromises(files: Record<string, string>): string[] {
	return Object.entries(files).flatMap(([file, text]) =>
		commentBlocks(text)
			.filter(
				(b) => ASKS_TO_KEEP_IN_STEP.test(b.text) && !NAMES_A_TEST.test(b.text),
			)
			.map((b) => `${file.replace("../", "")}:${b.line}`),
	);
}

describe("comments that ask to be kept in step", () => {
	it("each names the test that keeps it, or the two are made one definition", () => {
		expect(untestedPromises(SOURCES)).toEqual([]);
	});

	it("notices a comment that asks and names no test, and accepts one that names its test", () => {
		const bare = "// Keep it in step with includedSql.\nconst a = 1;\n";

		const tested =
			"// Keep it in step with includedSql (test/refunds.test.ts checks it).\nconst a = 1;\n";

		const unrelated = "// The twins Tally already holds on the Apple Card.\n";

		expect(untestedPromises({ "../src/a.ts": bare })).toEqual(["src/a.ts:1"]);
		expect(untestedPromises({ "../src/a.ts": tested })).toEqual([]);
		expect(untestedPromises({ "../src/a.ts": unrelated })).toEqual([]);
	});
});
