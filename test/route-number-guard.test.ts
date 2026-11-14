import { describe, expect, it } from "vitest";

// The route files read what a person types, posts or links with numberOf, numberOfPosted, rowIdOf and the other
// kinds in src/edge-kinds.ts (#1105), not with Number() or parseInt(). This test reads every file in src/routes/ as
// text and lists each call of Number, parseInt or parseFloat that is left. Each one is on the list below with the
// reason it is not an input read. A new call fails the test, a listed call that is gone fails it, and so does a
// listed call that now appears more times than the list allows. Comments and string literals are not code: a word
// in them is ignored.

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

/** Blanks the comments, string literals, template text and regular expressions of a source file, keeping its layout. */
function codeOnly(src: string): string {
	const chars = [...src];
	const n = src.length;

	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (chars[k] !== "\n") chars[k] = " ";
	};

	// Template text from `start` to the closing backtick (expr: false) or to a "${" (expr: true), blanked.
	const templateText = (start: number) => {
		let k = start;

		while (k < n) {
			if (src[k] === "\\") {
				k += 2;
				continue;
			}

			if (src[k] === "`") {
				blank(start, k);

				return { at: k + 1, expr: false };
			}

			if (src[k] === "$" && src[k + 1] === "{") {
				blank(start, k);

				return { at: k + 2, expr: true };
			}

			k++;
		}

		blank(start, n);

		return { at: n, expr: false };
	};

	// The brace depth at each open "${", so the template resumes at its own closing brace.
	const templates: number[] = [];
	let depth = 0;
	let last = ""; // the last code character that is not white space: decides whether a "/" starts a regular expression
	let i = 0;

	while (i < n) {
		const c = src[i] ?? "";
		const d = src[i + 1] ?? "";

		if (c === "/" && d === "/") {
			const end = src.indexOf("\n", i);
			const stop = end < 0 ? n : end;

			blank(i, stop);
			i = stop;
			continue;
		}

		if (c === "/" && d === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end < 0 ? n : end + 2;

			blank(i, stop);
			i = stop;
			continue;
		}

		if (c === '"' || c === "'") {
			let k = i + 1;

			while (k < n && src[k] !== c && src[k] !== "\n") {
				if (src[k] === "\\") k++;
				k++;
			}

			blank(i + 1, k);
			i = k + 1;
			last = '"';
			continue;
		}

		if (c === "`") {
			const text = templateText(i + 1);

			if (text.expr) templates.push(depth);
			last = text.expr ? "{" : '"';
			i = text.at;
			continue;
		}

		if (c === "/" && "(,=:[!&|?{};+-*%<>~^".includes(last || "(")) {
			let k = i + 1;
			let inClass = false;

			while (k < n && src[k] !== "\n") {
				if (src[k] === "\\") {
					k += 2;
					continue;
				}

				if (src[k] === "[") inClass = true;
				else if (src[k] === "]") inClass = false;
				else if (src[k] === "/" && !inClass) break;
				k++;
			}

			blank(i + 1, k);
			i = k + 1;
			last = '"';
			continue;
		}

		if (c === "{") depth++;

		if (c === "}" && templates.length && templates.at(-1) === depth) {
			templates.pop();

			const text = templateText(i + 1);

			if (text.expr) templates.push(depth);
			last = text.expr ? "{" : '"';
			i = text.at;
			continue;
		}

		if (c === "}") depth--;

		if (!/\s/.test(c)) last = c;
		i++;
	}

	return chars.join("");
}

/** The source text of the call that starts at `open` (a "("), through its matching ")". */
function callEnd(code: string, open: number): number {
	let depth = 0;

	for (let k = open; k < code.length; k++) {
		if (code[k] === "(") depth++;

		if (code[k] === ")") {
			depth--;

			if (depth === 0) return k + 1;
		}
	}

	return code.length;
}

type Found = { file: string; call: string; line: number };

/** Every value reference to Number, parseInt or parseFloat in one file, with its call text when it is called. */
function readsIn(file: string, src: string): Found[] {
	const code = codeOnly(src);
	const found: Found[] = [];
	const pattern = /(?<![\w$.])(Number|parseInt|parseFloat)(?![\w$])/g;

	for (const match of code.matchAll(pattern)) {
		const start = match.index ?? 0;
		let end = start + match[0].length;

		// Number.parseInt and Number.parseFloat are the same reads; other Number members (isInteger, NaN) are not.
		const member = /^\.(parseInt|parseFloat)\b/.exec(code.slice(end));

		if (match[0] === "Number" && member) {
			end += member[0].length;
		} else if (match[0] === "Number" && code[end] === ".") {
			continue;
		}

		const after = /^\s*\(/.exec(code.slice(end));
		const finish = after ? callEnd(code, end + after[0].length - 1) : end;
		const text = src.slice(start, finish).replace(/\s+/g, " ");

		found.push({
			file,
			call: text,
			line: code.slice(0, start).split("\n").length,
		});
	}

	return found;
}

describe("route files read their numbers at the edge (#1105)", () => {
	it("lists no Number, parseInt or parseFloat read outside the exceptions", () => {
		const found = Object.entries(sources).flatMap(([path, src]) =>
			readsIn(path.replace("../src/routes/", ""), src),
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
