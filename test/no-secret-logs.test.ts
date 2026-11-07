import { describe, expect, it } from "vitest";

// The rule (CLAUDE.md): never log tokens or transaction details. A log line is fixed words and, at most, an error's name,
// a count or an id the person already sees. This reads every console call in the app's own code (src, and the client
// scripts in public/js that run in the browser) and fails on an argument that names a secret or a piece of a transaction,
// that passes a whole object or a whole error, or that serialises a value. It checks the identifiers and expressions in a
// call, not the fixed words in its quoted text, so "the token has expired" may be said and a token may not be passed.

const SOURCES = {
	...import.meta.glob("../src/**/*.{ts,tsx}", {
		query: "?raw",
		import: "default",
		eager: true,
	}),
	...import.meta.glob("../public/js/**/*.js", {
		query: "?raw",
		import: "default",
		eager: true,
	}),
} as Record<string, string>;

/** Functions that only log what they are given, so their callers are checked as if they were console calls. */
const WRAPPERS = [{ file: "src/access.ts", name: "refuse" }];

/** Log calls that break a rule on purpose, each with the reason. A call that is no longer flagged fails the test. */
const EXCEPTIONS = [
	{
		file: "src/access.ts",
		call: "couldn't fetch the signing keys",
		why: "The message is a failed fetch of Cloudflare's public certs URL, kept so `wrangler tail` shows why Access sign-in is down (test/access.test.ts asserts it). It holds no token, claim, email or row text.",
	},
];

// An identifier that names a secret, or a part of a transaction.
const SECRET =
	/token|secret|api[_-]?key|authorization|password|credential|bearer/i;
const TRANSACTION =
	/raw_?name|merchant|amount|description|bank_?text|memo|payee|counterparty|account_?(?:number|id)/i;
// A whole error or its message, instead of its name.
const WHOLE_ERROR =
	/\$\{\s*(?:e|err|error|cause)\s*\}|\b(?:e|err|error|cause)\.(?:message|stack)\b|String\(\s*(?:e|err|error|cause)\s*\)|,\s*(?:e|err|error|cause)\s*,?\s*$/;
// A whole record passed as an argument: `console.log(transaction)`.
const OBJECT_NAMES = new Set([
	"transaction",
	"transactions",
	"tx",
	"txn",
	"row",
	"rows",
	"charge",
	"charges",
	"record",
	"records",
	"payload",
	"body",
	"env",
	"headers",
	"request",
	"response",
	"item",
	"items",
	"bill",
	"bills",
	"merchant",
	"account",
	"accounts",
	"candidate",
	"candidates",
	"snapshot",
	"snapshots",
	"result",
	"results",
]);

/**
 * The text with comments and the insides of string and template literals replaced by spaces (newlines kept), so a search
 * for code does not find `console.log(` in a comment or a string. Code inside a template's `${ }` is kept. `clean` is
 * false when the file ended inside a string, comment or template, which means this reading lost its place.
 */
function codeOnly(text: string): { code: string; clean: boolean } {
	const out = [...text];
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
	};
	// A stack of what is open: a template literal waiting for its `${` expressions, with the brace depth inside one.
	const braces: number[] = [];
	let i = 0;
	let mode: "code" | "template" = "code";
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (mode === "template") {
			if (ch === "\\") {
				blank(i, i + 2);
				i += 2;
			} else if (ch === "`") {
				// Back to code: the top level, or the \${ } of an outer template this one sits in.
				mode = "code";
				i++;
			} else if (ch === "$" && next === "{") {
				braces.push(0);
				mode = "code";
				i += 2;
			} else {
				blank(i, i + 1);
				i++;
			}
			continue;
		}
		if (ch === "/" && next === "/") {
			const end = text.indexOf("\n", i);
			const to = end === -1 ? text.length : end;
			blank(i, to);
			i = to;
		} else if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			const to = end === -1 ? text.length : end + 2;
			blank(i, to);
			i = to;
		} else if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < text.length && text[j] !== ch && text[j] !== "\n")
				j += text[j] === "\\" ? 2 : 1;
			blank(i + 1, j);
			i = j + 1;
		} else if (ch === "`") {
			mode = "template";
			i++;
		} else if (ch === "{" && braces.length) {
			braces[braces.length - 1] = (braces[braces.length - 1] ?? 0) + 1;
			i++;
		} else if (ch === "}" && braces.length) {
			const depth = braces[braces.length - 1] ?? 0;
			if (depth === 0) {
				braces.pop();
				mode = "template";
			} else braces[braces.length - 1] = depth - 1;
			i++;
		} else i++;
	}
	return { code: out.join(""), clean: mode === "code" && braces.length === 0 };
}

/** The text between the parentheses of a call whose `(` is just before `from`, and where the call ends. */
function argsFrom(text: string, from: number) {
	let depth = 1;
	let i = from;
	let quote: string | null = null;
	for (; i < text.length && depth > 0; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")") depth--;
	}
	return text.slice(from, i - 1);
}

type Call = { where: string; file: string; args: string; code: string };

/** Every log call in a file: console.log/error/warn/info/debug, and a call to a declared wrapper. */
function logCalls(file: string, text: string): Call[] {
	const { code } = codeOnly(text);
	const names = WRAPPERS.filter((w) => file.endsWith(w.file)).map(
		(w) => w.name,
	);
	const start = new RegExp(
		`\\b(?:console\\.(?:log|error|warn|info|debug)${names.map((n) => `|${n}`).join("")})\\(`,
		"g",
	);
	const calls: Call[] = [];
	for (let match = start.exec(code); match; match = start.exec(code)) {
		const from = match.index + match[0].length;
		const args = argsFrom(text, from);
		const line = text.slice(0, match.index).split("\n").length;
		calls.push({
			where: `${file.replace("../", "")}:${line}`,
			file: file.replace("../", ""),
			args,
			code: codeOnly(args).code,
		});
	}
	return calls;
}

/** The arguments of a call split at its top-level commas. */
function splitArgs(code: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of code) {
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		if (ch === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
		} else current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

/** The reasons a log call breaks the rule, empty when it keeps it. Reads the code in the call, not its quoted words. */
function problems({ code }: Pick<Call, "code">): string[] {
	const found: string[] = [];
	if (SECRET.test(code)) found.push("names a secret");
	if (TRANSACTION.test(code)) found.push("names part of a transaction");
	if (WHOLE_ERROR.test(code)) found.push("prints a whole error");
	if (/\bJSON\.stringify\(/.test(code)) found.push("serialises a value");
	const bare = splitArgs(code).some((part) => {
		if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(part)) return false;
		return OBJECT_NAMES.has(part.split(".").pop() ?? "");
	});
	if (bare) found.push("passes a whole record");
	return found;
}

const open = "$" + "{"; // so the fixtures below can hold template-literal code in plain strings

describe("the check itself", () => {
	const flagged = (code: string) =>
		logCalls("../src/x.ts", code).flatMap((call) => problems(call));

	it("flags a token, a transaction detail and a whole error, on one line or several", () => {
		expect(flagged("console.error('sync failed', accessToken)")).toContain(
			"names a secret",
		);
		expect(
			flagged(
				`console.log(\`bill ${open}row.merchant_name} for ${open}amount}\`)`,
			),
		).toContain("names part of a transaction");
		expect(flagged(`console.error(\`failed: ${open}error}\`)`)).toContain(
			"prints a whole error",
		);
		expect(flagged("console.error('failed', error.message)")).toContain(
			"prints a whole error",
		);
		expect(flagged("console.error(\n\t'failed',\n\terror,\n)")).toContain(
			"prints a whole error",
		);
		expect(
			flagged("console.error('plaid', (await r.text()).slice(0, 5), token)"),
		).toContain("names a secret");
	});

	it("flags a whole record, and a serialised value", () => {
		expect(flagged("console.log(transaction)")).toContain(
			"passes a whole record",
		);
		expect(flagged("console.log('saved', item.row)")).toContain(
			"passes a whole record",
		);
		expect(flagged("console.log(JSON.stringify(thing))")).toContain(
			"serialises a value",
		);
	});

	it("passes fixed words, words about a token, an error's name, a count and an id", () => {
		expect(flagged("console.error('sorting: stopped')")).toEqual([]);
		expect(flagged("console.warn('the token has expired')")).toEqual([]);
		expect(
			flagged(
				"console.error('sync failed', error instanceof Error ? error.name : 'unknown')",
			),
		).toEqual([]);
		expect(
			flagged(`console.log(\`synced ${open}count} rows in ${open}ms} ms\`)`),
		).toEqual([]);
		expect(flagged(`console.log(\`item ${open}item.id} failed\`)`)).toEqual([]);
	});

	it("ignores a console call in a comment or in a string, and still reads the code around them", () => {
		expect(flagged("// console.log(token)\nconst a = 1;")).toEqual([]);
		expect(flagged("/* console.log(token) */ const a = 1;")).toEqual([]);
		expect(flagged("const s = 'console.log(token)';")).toEqual([]);
		expect(flagged(`const s = \`console.log(${open}x}) token\`;`)).toEqual([]);
		expect(flagged("// note\nconsole.log(token)")).toContain("names a secret");
		expect(flagged(`const s = \`${open}f(console.log(token))}\`;`)).toContain(
			"names a secret",
		);
	});

	it("checks the calls to a declared wrapper like console calls", () => {
		const calls = logCalls(
			"../src/access.ts",
			`refuse('no header'); refuse(\`failed (${open}error.message})\`)`,
		);
		expect(calls.map((c) => problems(c))).toEqual([
			[],
			["prints a whole error"],
		]);
	});

	it("reads a call whose arguments hold parentheses and quoted brackets", () => {
		const calls = logCalls(
			"../src/x.ts",
			"console.error(f(')'), 'a)b'); console.log('next')",
		);
		expect(calls.map((c) => c.args)).toEqual(["f(')'), 'a)b'", "'next'"]);
	});

	it("keeps its place in every file it reads, so a regex or odd quote cannot hide a call", () => {
		const lost = Object.entries(SOURCES)
			.filter(([, text]) => !codeOnly(text).clean)
			.map(([file]) => file);
		expect(lost).toEqual([]);
	});
});

describe("what the app logs", () => {
	const calls = Object.entries(SOURCES).flatMap(([file, text]) =>
		logCalls(file, text),
	);
	const unexcused = calls.filter(
		(call) =>
			problems(call).length > 0 &&
			!EXCEPTIONS.some(
				(e) => call.file === e.file && call.args.includes(e.call),
			),
	);

	it("finds the log calls it is checking, client scripts included", () => {
		expect(calls.length).toBeGreaterThan(30);
		expect(Object.keys(SOURCES).some((f) => f.includes("public/js/"))).toBe(
			true,
		);
	});

	it("never names a secret, names a transaction detail, or passes a whole record or error", () => {
		expect(
			unexcused.map(
				(c) => `${c.where}: ${problems(c).join(", ")}: ${c.args.slice(0, 80)}`,
			),
		).toEqual([]);
	});

	it("keeps each exception only while the call it excuses still breaks the rule", () => {
		const stale = EXCEPTIONS.filter(
			(e) =>
				!calls.some(
					(c) =>
						c.file === e.file &&
						c.args.includes(e.call) &&
						problems(c).length > 0,
				),
		);
		expect(stale).toEqual([]);
	});
});
