import { describe, expect, it } from "vitest";

// The rule (CLAUDE.md): never log tokens or transaction details. A log line is fixed words and, at most, an error's name,
// a count or an id the person already sees. This reads every console call in src and fails on an argument that names a
// secret or a piece of a transaction, or that prints a whole error (its message can carry row text).

const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

/** The text of every console.log/error/warn/info call's arguments, with the file and line it starts on. */
function consoleCalls(file: string, text: string) {
	const calls: { where: string; args: string }[] = [];
	const start = /\bconsole\.(?:log|error|warn|info|debug)\(/g;
	for (let match = start.exec(text); match; match = start.exec(text)) {
		let depth = 1;
		let i = match.index + match[0].length;
		let quote: string | null = null;
		const from = i;
		for (; i < text.length && depth > 0; i++) {
			const ch = text[i];
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = null;
			} else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if (ch === "(") depth++;
			else if (ch === ")") depth--;
		}
		const line = text.slice(0, match.index).split("\n").length;
		calls.push({
			where: `${file.replace("../", "")}:${line}`,
			args: text.slice(from, i - 1),
		});
	}
	return calls;
}

// Words that name a secret, or a part of a transaction, wherever they appear in a log call's arguments. They are matched
// on the code only: the fixed words inside a quoted string are checked for the same list, so a message may not say them.
const SECRET =
	/token|secret|api[_-]?key|authorization|password|credential|bearer/i;
const TRANSACTION =
	/raw_?name|merchant|amount|description|bank_?text|memo|payee|counterparty|account_?(?:number|id)/i;
// A whole error, or its message, instead of its name.
const WHOLE_ERROR =
	/\$\{\s*(?:e|err|error|cause)\s*\}|\b(?:e|err|error|cause)\.(?:message|stack)\b|String\(\s*(?:e|err|error|cause)\s*\)|,\s*(?:e|err|error|cause)\s*,?\s*$/;

/** The reasons a log call's arguments break the rule, empty when they keep it. */
const problems = (args: string) => [
	...(SECRET.test(args) ? ["names a secret"] : []),
	...(TRANSACTION.test(args) ? ["names part of a transaction"] : []),
	...(WHOLE_ERROR.test(args) ? ["prints a whole error"] : []),
];

// "${" is built here so the fixtures below can hold template-literal code in plain strings.
const open = "$" + "{";

describe("the check itself", () => {
	const flagged = (code: string) =>
		consoleCalls("../src/x.ts", code).flatMap(({ args }) => problems(args));

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
			flagged(
				"console.error('plaid', (await response.text()).slice(0, 5), token)",
			),
		).toContain("names a secret");
	});

	it("passes fixed words, an error's name and a count", () => {
		expect(flagged("console.error('sorting: stopped')")).toEqual([]);
		expect(
			flagged(
				"console.error('sync failed', error instanceof Error ? error.name : 'unknown')",
			),
		).toEqual([]);
		expect(
			flagged(`console.log(\`synced ${open}count} rows in ${open}ms} ms\`)`),
		).toEqual([]);
	});

	it("reads a call whose arguments hold parentheses and quoted brackets", () => {
		const calls = consoleCalls(
			"../src/x.ts",
			"console.error(f(')'), 'a)b'); console.log('next')",
		);
		expect(calls.map((c) => c.args)).toEqual(["f(')'), 'a)b'", "'next'"]);
	});
});

describe("what the app logs", () => {
	const calls = Object.entries(SOURCES).flatMap(([file, text]) =>
		consoleCalls(file, text),
	);

	it("finds the log calls it is checking", () => {
		expect(calls.length).toBeGreaterThan(30);
	});

	it("never names a secret in a log call", () => {
		const offenders = calls.filter(({ args }) => SECRET.test(args));
		expect(offenders.map((c) => `${c.where}: ${c.args.slice(0, 80)}`)).toEqual(
			[],
		);
	});

	it("never names a part of a transaction in a log call", () => {
		const offenders = calls.filter(({ args }) => TRANSACTION.test(args));
		expect(offenders.map((c) => `${c.where}: ${c.args.slice(0, 80)}`)).toEqual(
			[],
		);
	});

	it("never prints a whole error or its message", () => {
		const offenders = calls.filter(({ args }) => WHOLE_ERROR.test(args));
		expect(offenders.map((c) => `${c.where}: ${c.args.slice(0, 80)}`)).toEqual(
			[],
		);
	});
});
