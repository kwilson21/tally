import { describe, expect, it } from "vitest";

// The route files read what a person types, posts or links with numberOf, numberOfPosted, rowIdOf and the other
// kinds in src/edge-kinds.ts (#1105), not with Number() or parseInt(). This guard reads every file in src/routes/ as
// raw text and finds each Number, parseInt and parseFloat that is left, including a function reference such as
// .map(Number). It does not parse the code and it does not strip comments or strings, so nothing can hide a read: a
// word in a comment or a string is reported too, and must be reworded or listed. Each hit is on the list below with
// the reason it is not an input read. A new hit fails the test, a listed hit that is gone fails it, and so does a
// listed hit that now appears more times than the list allows.

const sources = import.meta.glob(
	["../src/routes/**/*.ts", "../src/routes/**/*.tsx"],
	{ query: "?raw", import: "default", eager: true },
);

type Exception = { file: string; call: string; count: number; why: string };

/** The calls that are not input reads, with the reason each one is safe (the count is how many of that text the file has). */
const EXCEPTIONS: Exception[] = [
	{
		file: "accounts.tsx",
		call: "Number(declared)",
		count: 1,
		why: "The request's content-length, after /^\\d+$/ has checked it: a header, not a form or a query.",
	},
	{
		file: "push.ts",
		call: "Number(declared)",
		count: 1,
		why: "The request's content-length, after /^\\d{1,9}$/ has checked it: a header, not a form or a query.",
	},
	{
		file: "bills.tsx",
		call: "Number(period.slice(-1))",
		count: 1,
		why: "The quarter digit of a period that billPeriods or periods.includes has already accepted.",
	},
	{
		file: "bills.tsx",
		call: "Number(period.slice(0, 4))",
		count: 1,
		why: "The year of a period that billPeriods or periods.includes has already accepted.",
	},
	{
		file: "bills.tsx",
		call: "Number(month.slice(0, 4))",
		count: 2,
		why: "The year of a month built from a period that was already accepted (an occurrence's month, never typed).",
	},
	{
		file: "bills.tsx",
		call: "Number(month.slice(5, 7))",
		count: 2,
		why: "The month of a month built from a period that was already accepted (an occurrence's month, never typed).",
	},
	{
		file: "home.tsx",
		call: "Number(today.slice(8, 10))",
		count: 1,
		why: "The day of the household's today, a date the server made: a stored date part, not an input.",
	},
	{
		file: "plaid.tsx",
		call: "Number(inserted?.meta.last_row_id)",
		count: 1,
		why: "The row id the database returns for an insert: a database value, not an input.",
	},
	{
		file: "settings.tsx",
		call: "Number(saved?.[0]?.meta.last_row_id)",
		count: 1,
		why: "The row id the database returns for a saved person: a database value, not an input.",
	},
	{
		file: "settings.tsx",
		call: "Number(saved?.[1]?.meta.last_row_id)",
		count: 1,
		why: "The row id the database returns for a saved row: a database value, not an input.",
	},
];

/** The Number members that are not reads: Number.isInteger and the constants. Any other Number member counts as a read. */
const NUMBER_NON_READ =
	/^\.(isInteger|isSafeInteger|isFinite|isNaN|NaN|MAX_SAFE_INTEGER|MIN_SAFE_INTEGER|MAX_VALUE|MIN_VALUE|EPSILON|POSITIVE_INFINITY|NEGATIVE_INFINITY)\b/;

/** The text of the parenthesised group that starts at `open` (a "("), or to the end of the text when it never closes. */
function groupEnd(src: string, open: number): number {
	let depth = 0;

	for (let k = open; k < src.length; k++) {
		if (src[k] === "(") depth++;

		if (src[k] === ")") {
			depth--;

			if (depth === 0) return k + 1;
		}
	}

	return src.length;
}

type NumberRead = { call: string; line: number };

/**
 * Every Number, parseInt or parseFloat in a source text, as raw text: calls, function references such as
 * .map(Number), and words in comments and strings. Number.isInteger and the other Number constants are not reads;
 * Number.parseInt and Number.parseFloat are. Schema.Number and a longer name (toNumber, isNumber) are not matched.
 */
function numberReads(src: string): NumberRead[] {
	const reads: NumberRead[] = [];
	// A name after a dot is a read too (globalThis.Number, window.parseInt): only the identifier's own edge counts.
	const pattern = /(?<![\w$])(Number|parseInt|parseFloat)(?![\w$])/g;

	for (const match of src.matchAll(pattern)) {
		const start = match.index ?? 0;
		let end = start + match[0].length;
		const before = src.slice(Math.max(0, start - 40), start);

		// Schema.Number is a schema, not the global Number.
		if (match[0] === "Number" && /\bSchema\s*\.\s*$/.test(before)) continue;

		// Number.parseInt is read once, at its Number.
		if (match[0] !== "Number" && /\bNumber\s*\.\s*$/.test(before)) continue;

		if (match[0] === "Number" && src[end] === ".") {
			const member = /^\.(parseInt|parseFloat)\b/.exec(src.slice(end));

			if (member) end += member[0].length;
			else if (NUMBER_NON_READ.test(src.slice(end))) continue;
		}

		const called = /^\s*\(/.exec(src.slice(end));
		const finish = called ? groupEnd(src, end + called[0].length - 1) : end;

		reads.push({
			call: src.slice(start, finish).replace(/\s+/g, " "),
			line: src.slice(0, start).split("\n").length,
		});
	}

	return reads;
}

describe("the number-read scanner (#1105)", () => {
	it("reports a read that a JSX text apostrophe or a closing tag would hide", () => {
		const jsxApostrophe = 'const a = <p>don\'t {Number(form.get("x"))}</p>;';

		const jsxClosingTags =
			'<><p>x</p><span>{Number(form.get("z"))}</span></></>;';

		expect(numberReads(jsxApostrophe).map((r) => r.call)).toEqual([
			'Number(form.get("x"))',
		]);
		expect(numberReads(jsxClosingTags).map((r) => r.call)).toEqual([
			'Number(form.get("z"))',
		]);
	});

	it("reports a read in a comment and in a string literal", () => {
		expect(numberReads("// Number(x)").map((r) => r.call)).toEqual([
			"Number(x)",
		]);
		expect(numberReads('const s = "Number(x)";').map((r) => r.call)).toEqual([
			"Number(x)",
		]);
	});

	it("reports a function reference such as .map(Number), and Number.parseInt", () => {
		expect(numberReads("xs.map(Number)").map((r) => r.call)).toEqual([
			"Number",
		]);
		expect(numberReads("Number.parseInt(s, 10)").map((r) => r.call)).toEqual([
			"Number.parseInt(s, 10)",
		]);
	});

	it("does not report Number.isInteger, the Number constants, or Schema.Number", () => {
		expect(
			numberReads(
				"Number.isInteger(x) && Number.isSafeInteger(x) && x > Number.MAX_SAFE_INTEGER",
			),
		).toEqual([]);
		expect(numberReads("Number.NaN; Number.isNaN(x); Schema.Number")).toEqual(
			[],
		);
	});

	it("does not report a longer name that contains Number", () => {
		expect(numberReads("toNumber(x); isNumber(x); myparseInt(x)")).toEqual([]);
	});

	it("reports a Number or parseInt reached through an object (globalThis, window, self, global)", () => {
		for (const probe of [
			"globalThis.Number(x)",
			"window.parseInt(x)",
			"self.Number(x)",
			"global.parseFloat(x)",
			"globalThis . Number (x)",
		])
			expect(numberReads(probe), probe).toHaveLength(1);
	});

	it("does not report Schema.Number, Number.isInteger or Number.MAX_SAFE_INTEGER", () => {
		for (const probe of [
			"Schema.Number",
			"Number.isInteger(x)",
			"Number.MAX_SAFE_INTEGER",
		])
			expect(numberReads(probe), probe).toEqual([]);
	});
});

describe("route files read their numbers at the edge (#1105)", () => {
	it("lists no Number, parseInt or parseFloat read outside the exceptions", () => {
		const found = Object.entries(sources).flatMap(([path, src]) =>
			numberReads(src).map((read) => ({
				file: path.replace("../src/routes/", ""),
				call: read.call,
				line: read.line,
			})),
		);

		const problems: string[] = [];
		const keys = new Set(found.map((f) => `${f.file}: ${f.call}`));

		for (const key of keys) {
			const hits = found.filter((f) => `${f.file}: ${f.call}` === key);
			const listed = EXCEPTIONS.find((e) => `${e.file}: ${e.call}` === key);
			const allowed = listed?.count ?? 0;

			if (hits.length > allowed) {
				const lines = hits.map((h) => `${h.file}:${h.line}`).join(", ");

				problems.push(
					`${key} is not on the exceptions list (${hits.length} found, ${allowed} listed) at ${lines}`,
				);
			}
		}

		for (const entry of EXCEPTIONS) {
			const key = `${entry.file}: ${entry.call}`;
			const actual = found.filter((f) => `${f.file}: ${f.call}` === key).length;

			if (actual < entry.count)
				problems.push(
					`${key} is listed ${entry.count} times but found ${actual}: remove it from the list`,
				);
		}

		expect(problems).toEqual([]);
	});
});
