import { describe, expect, it } from "vitest";

// Every file whose comments can ask a person to keep two things in step.
const SOURCES = import.meta.glob<string>(
	["../src/**/*.{ts,tsx,css}", "../public/js/*.js"],
	{ query: "?raw", import: "default", eager: true },
);

// A comment that says one thing must be kept in step with another is a promise only a person keeps.
// It is fine when a test keeps it instead, so the comment has to name which one: a test file, like test/refunds.test.ts.
const ASKS_TO_KEEP_IN_STEP =
	/\bkeep\b[^\n]{0,80}?\bin step\b|\bin step with\b|\b(?:SQL|plan) twin\b|\btwin of\b/i;

const NAMES_A_TEST_FILE = /[\w-]+\.test\.tsx?\b/;

/**
 * Each run of consecutive lines that hold comment text as one block, with its first line number. A line holds comment
 * text when it is inside a block comment, starts a comment (`//` or `/*`), or has a comment after code. A `//` counts
 * after code only with a space before it, so the one in `https://example.com` is not a comment.
 */
function commentBlocks(text: string): { line: number; text: string }[] {
	const blocks: { line: number; text: string }[] = [];
	let current: { line: number; text: string } | undefined;
	let inBlock = false;

	for (const [i, raw] of text.split("\n").entries()) {
		let comment = "";

		if (inBlock) {
			const close = raw.indexOf("*/");

			// Comment text ends at the `*/`; whatever follows it on the line is code.
			comment = close === -1 ? raw : raw.slice(0, close + 2);
			inBlock = close === -1;
		} else {
			// Look for the marker with string literals blanked out (same length, so positions still line up).
			const blanked = raw.replace(
				/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
				(literal) => "x".repeat(literal.length),
			);
			// The first comment marker on the line: at its start, after a space, or after the `{` of a JSX comment.

			const marker = /(^|[\s{])(\/\/|\/\*)/.exec(blanked);

			if (marker) {
				const at = marker.index + (marker[1] ?? "").length;
				const rest = raw.slice(at);
				const close = marker[2] === "/*" ? rest.indexOf("*/", 2) : -1;

				// A `/*` opens a block unless the same line closes it; a `/*` inside a `//` comment is just text.
				comment = close === -1 ? rest : rest.slice(0, close + 2);
				inBlock = marker[2] === "/*" && close === -1;
			}
		}

		if (comment) {
			current ??= { line: i + 1, text: "" };
			current.text += `${comment}\n`;
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
				(b) =>
					ASKS_TO_KEEP_IN_STEP.test(b.text) && !NAMES_A_TEST_FILE.test(b.text),
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
		const noName = "// Keep it in step with X (the tests check it).\n";
		const trailing = "const a = 1; // Keep it in step with b.\n";
		const block = "/*\n Keep it in step with b.\n*/\nconst a = 1;\n";
		const jsx = "{/* Keep this in step with b. */}\n";
		const named = "// Keep includedSql and isIncluded in step.\n";

		const lineWithMarker =
			'// the route glob is "/design-system/*"\nconst a = 1;\n// Keep it in step with b.\n';

		const afterClose =
			'/* Keep A in step with B. */ const f = "fake.test.ts";\n';

		const dotted = "// Keep foo.ts and bar.ts in step.\n";

		const inString =
			'const e = " // Keep A in step with B."; const g = "/*";\n';

		const url = 'const u = "https://x.test/a"; const b = 2;\n';

		expect(untestedPromises({ "../src/a.ts": bare })).toEqual(["src/a.ts:1"]);
		expect(untestedPromises({ "../src/a.ts": tested })).toEqual([]);
		expect(untestedPromises({ "../src/a.ts": unrelated })).toEqual([]);
		expect(untestedPromises({ "../src/a.ts": noName })).toEqual(["src/a.ts:1"]);
		expect(untestedPromises({ "../src/a.ts": trailing })).toEqual([
			"src/a.ts:1",
		]);
		expect(untestedPromises({ "../src/a.ts": block })).toEqual(["src/a.ts:1"]);
		expect(untestedPromises({ "../src/a.ts": url })).toEqual([]);
		expect(untestedPromises({ "../src/a.ts": afterClose })).toEqual([
			"src/a.ts:1",
		]);
		expect(untestedPromises({ "../src/a.ts": dotted })).toEqual(["src/a.ts:1"]);
		expect(untestedPromises({ "../src/a.ts": inString })).toEqual([]);
		expect(untestedPromises({ "../src/a.tsx": jsx })).toEqual(["src/a.tsx:1"]);
		expect(untestedPromises({ "../src/a.ts": named })).toEqual(["src/a.ts:1"]);
		expect(untestedPromises({ "../src/a.ts": lineWithMarker })).toEqual([
			"src/a.ts:3",
		]);
	});
});
