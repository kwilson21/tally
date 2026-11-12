import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAst } from "vitest/node";
import { itemAt } from "../test/helpers/present";

// The rule (CLAUDE.md): never log tokens or transaction details. A log line is fixed words and, at most, an error's name,
// a count or an id the person already sees. This parses every file of the app's own code (src, and the scripts under public
// that run in the browser, the service worker included), finds every call to a console method, and fails on an argument that names a secret
// or a piece of a transaction, passes a whole record or a whole error, or serialises a value. It reads the code in a call,
// not its quoted words, so "the token has expired" may be said and a token may not be passed.
//
// It runs here, under plain Node, because the parser (the one Vite uses, from vitest/node) needs a Node host; the Worker
// test runtime has no file system. `npm run test:feedback-integration` runs it in CI.

const ROOT = path.join(import.meta.dirname, "..");

/** The files the rule covers, as paths from the repo root with the source text. */
function appFiles(): { file: string; text: string }[] {
	const files: { file: string; text: string }[] = [];

	for (const [dir, pattern] of [
		["src", /\.(?:ts|tsx)$/],
		["public", /\.js$/],
	] as const) {
		for (const entry of readdirSync(path.join(ROOT, dir), {
			encoding: "utf8",
			recursive: true,
		})) {
			const parts = entry.split(path.sep);

			// The vendored libraries (htmx, html2canvas) are not ours to audit.
			if (dir === "public" && parts[0] === "vendor") continue;

			if (!pattern.test(entry) || entry.endsWith(".d.ts")) continue;
			const file = path.posix.join(dir, parts.join("/"));
			files.push({ file, text: readFileSync(path.join(ROOT, file), "utf8") });
		}
	}

	return files;
}

/**
 * The findings the exceptions excuse. An exception excuses its call only when that exact call, in that file, appears once:
 * a copy of it elsewhere is a new call that nobody reviewed, so neither is excused.
 */
function excuse(findings: Finding[]): Finding[] {
	return EXCEPTIONS.flatMap((e) => {
		const matches = findings.filter(
			(f) =>
				f.file === e.file &&
				f.call === e.call &&
				f.problems.every((problem) => e.allows.includes(problem)),
		);

		return matches.length === 1 ? matches : [];
	});
}

const open = "$" + "{"; // so strings below can hold template-literal code without tripping the lint rule for it

/** Functions that only log what they are given, so their callers are checked as if they were console calls. */
const WRAPPERS = [{ file: "src/access.ts", name: "refuse" }];

/**
 * Log calls that break a rule on purpose. Each names the exact call (its source text, whitespace squeezed), the problems
 * it may have, and why. Changing the call, or adding a problem to it, fails the test until someone reviews it again.
 */
const EXCEPTIONS = [
	{
		file: "src/access.ts",
		call: `refuse( \`couldn't fetch the signing keys from https://${open}domain}/cdn-cgi/access/certs (${open}error instanceof Error ? \`${open}error.name}: ${open}error.message}\` : "unknown error"})\`, )`,
		allows: ["prints a whole error"],
		why: "The message is a failed fetch of Cloudflare's public certs URL, kept so `wrangler tail` shows why Access sign-in is down (test/access.test.ts asserts it). It holds no token, claim, email or row text.",
	},
];

// A name that says a secret, or a part of a transaction.
const SECRET =
	/token|secret|api[_-]?key|private[_-]?key|authorization|password|credential|bearer/i;

const TRANSACTION =
	/raw_?name|merchant|amount|description|bank_?text|memo|payee|counterparty|account_?(?:number|id)/i;

// Words that name a transaction's free text; matched as whole words of a name, so `note` and `rowNote` but not `denote`.
const TRANSACTION_WORDS = new Set(["note", "notes"]);
const ERROR_NAMES = new Set(["e", "err", "error", "cause"]);

// A whole record passed as an argument: `console.log(transaction)`.
const RECORD_NAMES = new Set([
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

/** What an AST field holds: a child node, a list of them, or a leaf value. */
type Field =
	| Node
	| Field[]
	| string
	| number
	| boolean
	| bigint
	| RegExp
	| null
	| undefined;

type Node = {
	type: string;
	start: number;
	end: number;
	[key: string]: Field;
};

/** The root of a parsed file: the syntax tree the parser returns. */
type Parsed = ReturnType<typeof parseAst>;

const isNode = (value: Field | Parsed): value is Node =>
	typeof value === "object" &&
	value !== null &&
	"type" in value &&
	typeof value.type === "string";

/** A string leaf. This is the one place the file checks a value's type at run time. */
function isText(value: Field): value is string {
	return typeof value === "string";
}

/** The child nodes in a list field; holes and leaves in the list are skipped. */
function nodesOf(value: Field): Node[] {
	return Array.isArray(value) ? value.filter(isNode) : [];
}

/** The direct child nodes of a node. */
function children(node: Node): Node[] {
	const out: Node[] = [];

	for (const [key, value] of Object.entries(node)) {
		if (key === "type" || key === "start" || key === "end") continue;

		if (Array.isArray(value)) out.push(...value.filter(isNode));
		else if (isNode(value)) out.push(value);
	}

	return out;
}

/** Every node under (and including) this one. */
function* descendants(node: Node): Generator<Node> {
	yield node;

	for (const child of children(node)) yield* descendants(child);
}

const name = (node: Field): string | null =>
	isNode(node) && node.type === "Identifier" ? String(node.name) : null;

/** The name a property is reached by: `.x`, or `["x"]` with a quoted name. */
function propertyName(member: Node): string | null {
	const property = member.property;

	if (!member.computed) return name(property);

	return isNode(property) &&
		property.type === "Literal" &&
		isText(property.value)
		? property.value
		: null;
}

/** A name split into lower-case words: `rowNote` and `row_note` are `row`, `note`. */
const nameWords = (identifier: string) =>
	identifier
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

/** The identifiers and property names an expression reaches, never the words inside its quoted text. */
function namesIn(expression: Node): string[] {
	const names: string[] = [];

	for (const node of descendants(expression)) {
		if (node.type === "Identifier") names.push(String(node.name));
		else if (node.type === "MemberExpression") {
			const property = propertyName(node);

			if (property) names.push(property);
		}
	}

	return names;
}

/** The names along a plain path: `a.b.c` is [a, b, c]; null when the node is not a plain path. */
function pathNames(node: Node): string[] | null {
	if (node.type === "Identifier") return [String(node.name)];

	if (node.type === "MemberExpression" && isNode(node.object)) {
		const head = pathNames(node.object);
		const property = propertyName(node);

		return head && property ? [...head, property] : null;
	}

	return null;
}

/** A plain path whose last name is in `set`. */
const endsInName = (node: Node, set: Set<string>) => {
	const names = pathNames(node);

	return names !== null && set.has(names.at(-1) ?? "");
};

/** A whole record: a bare record name, or a path ending in one. */
const wholeRecord = (node: Node) => endsInName(node, RECORD_NAMES);

/** A whole error or its message or stack: `error`, `result.error`, `error.message`, `String(error)`. */
function wholeError(node: Node): boolean {
	const names = pathNames(node);

	if (names) {
		const last = names.at(-1) ?? "";

		if (ERROR_NAMES.has(last)) return true;

		return (
			["message", "stack"].includes(last) && ERROR_NAMES.has(names.at(-2) ?? "")
		);
	}

	if (node.type === "CallExpression")
		return (
			name(node.callee) === "String" && nodesOf(node.arguments).some(wholeError)
		);

	return false;
}

/**
 * The values an expression can print: the expression itself, or what it holds. Array elements, object property values,
 * template parts, spread arguments, the branches of a condition, either side of `&&`/`||`/`??`, and a cast or
 * `await` around a value all carry the value through to the log.
 */
function* valuesOf(node: Field): Generator<Node> {
	if (!isNode(node)) return;

	switch (node.type) {
		case "ArrayExpression":
			for (const element of nodesOf(node.elements)) yield* valuesOf(element);

			return;
		case "ObjectExpression":
			for (const property of nodesOf(node.properties)) {
				if (property.type === "SpreadElement")
					yield* valuesOf(property.argument);
				else yield* valuesOf(property.value);
			}

			return;
		case "TemplateLiteral":
			for (const part of nodesOf(node.expressions)) yield* valuesOf(part);

			return;
		case "ConditionalExpression":
			yield* valuesOf(node.consequent);
			yield* valuesOf(node.alternate);

			return;
		case "LogicalExpression":
			yield* valuesOf(node.left);
			yield* valuesOf(node.right);

			return;
		case "SpreadElement":
		case "AwaitExpression":
		case "ParenthesizedExpression":
		case "TSAsExpression":
		case "TSNonNullExpression":
		case "TSSatisfiesExpression":
			yield* valuesOf(node.argument ?? node.expression);

			return;
		default:
			yield node;
	}
}

/** The reasons one argument of a log call breaks the rule. */
function argumentProblems(argument: Node): string[] {
	const found = new Set<string>();
	const names = namesIn(argument);

	if (names.some((n) => SECRET.test(n))) found.add("names a secret");

	if (
		names.some(
			(n) =>
				TRANSACTION.test(n) ||
				nameWords(n).some((word) => TRANSACTION_WORDS.has(word)),
		)
	)
		found.add("names part of a transaction");

	for (const value of valuesOf(argument)) {
		if (wholeError(value)) found.add("prints a whole error");

		if (wholeRecord(value)) found.add("passes a whole record");
	}

	for (const node of descendants(argument)) {
		if (
			node.type === "CallExpression" &&
			isNode(node.callee) &&
			node.callee.type === "MemberExpression" &&
			name(node.callee.object) === "JSON" &&
			propertyName(node.callee) === "stringify"
		)
			found.add("serialises a value");
	}

	return [...found];
}

/** `console`, or the same object reached through a global: `window.console`, `globalThis.console`, `self.console`. */
function isConsoleObject(node: Node): boolean {
	if (name(node) === "console") return true;

	return (
		node.type === "MemberExpression" &&
		propertyName(node) === "console" &&
		["window", "globalThis", "self", "global"].includes(name(node.object) ?? "")
	);
}

type Finding = {
	where: string;
	file: string;
	call: string;
	problems: string[];
};

/** Every log call in a source file: a console method of any kind, or a call to a declared wrapper. */
function auditSource(file: string, text: string): Finding[] {
	const lang = file.endsWith(".tsx")
		? "tsx"
		: file.endsWith(".js")
			? "js"
			: "ts";

	const parsed = parseAst(text, { lang });

	if (!isNode(parsed))
		throw new Error(`${file}: the parser returned no syntax tree`);

	const wrappers = WRAPPERS.flatMap((w) => (file === w.file ? [w.name] : []));
	const findings: Finding[] = [];

	for (const node of descendants(parsed)) {
		if (node.type !== "CallExpression" || !isNode(node.callee)) continue;
		const callee = node.callee;

		const isConsole =
			callee.type === "MemberExpression" &&
			isNode(callee.object) &&
			isConsoleObject(callee.object);

		const isWrapper = wrappers.includes(name(callee) ?? "");

		if (!isConsole && !isWrapper) continue;

		const problems = [
			...new Set(
				nodesOf(node.arguments).flatMap((argument) =>
					argumentProblems(argument),
				),
			),
		];

		findings.push({
			where: `${file}:${text.slice(0, node.start).split("\n").length}`,
			file,
			call: text.slice(node.start, node.end).replace(/\s+/g, " "),
			problems,
		});
	}

	return findings;
}

describe("the check itself", () => {
	const problemsOf = (code: string, file = "src/x.ts") =>
		auditSource(file, code).flatMap((f) => f.problems);

	it("flags a token, a transaction detail and a whole error, in any shape", () => {
		expect(problemsOf("console.error('sync failed', accessToken)")).toContain(
			"names a secret",
		);
		expect(
			problemsOf(
				`console.log(\`bill ${open}row.merchant_name} for ${open}amount}\`)`,
			),
		).toContain("names part of a transaction");
		expect(problemsOf(`console.error(\`failed: ${open}error}\`)`)).toContain(
			"prints a whole error",
		);
		expect(problemsOf("console.error('failed', error.message)")).toContain(
			"prints a whole error",
		);
		expect(problemsOf("console.error(error)")).toContain(
			"prints a whole error",
		);
		expect(problemsOf("console.error(\n\t'failed',\n\terror,\n)")).toContain(
			"prints a whole error",
		);
		expect(problemsOf("console.error(String(err))")).toContain(
			"prints a whole error",
		);
	});

	it("flags a secret reached by bracket access, a private key, and a secret next to a comment or a regex", () => {
		expect(problemsOf('console.log(env["PLAID_SECRET"])')).toContain(
			"names a secret",
		);
		expect(problemsOf("console.log(env.VAPID_PRIVATE_KEY)")).toContain(
			"names a secret",
		);
		expect(problemsOf("console.log(/* ) */ token)")).toContain(
			"names a secret",
		);
		expect(problemsOf("const quote = /'/; console.log(token)")).toContain(
			"names a secret",
		);
	});

	it("flags a whole record in any console method, bare or inside an object literal", () => {
		for (const method of ["log", "table", "dir", "trace", "debug", "warn"])
			expect(problemsOf(`console.${method}(transactions)`)).toContain(
				"passes a whole record",
			);
		expect(problemsOf("console.log({ transaction })")).toContain(
			"passes a whole record",
		);
		expect(problemsOf("console.log({ saved: item.row })")).toContain(
			"passes a whole record",
		);
		expect(problemsOf("console.log('saved', item.row)")).toContain(
			"passes a whole record",
		);
		expect(problemsOf(`console.log(\`row ${open}tx}\`)`)).toContain(
			"passes a whole record",
		);
	});

	it("flags a transaction's note, and a record or error held in an array, a condition or a path", () => {
		expect(problemsOf("console.log(row.note)")).toContain(
			"names part of a transaction",
		);
		expect(problemsOf("console.log(notes)")).toContain(
			"names part of a transaction",
		);
		expect(problemsOf("console.log(denote, footnote)")).toEqual([]);
		expect(problemsOf("console.log([transaction])")).toContain(
			"passes a whole record",
		);
		expect(problemsOf("console.log(ok ? transaction : null)")).toContain(
			"passes a whole record",
		);
		expect(problemsOf("console.log(...rows)")).toContain(
			"passes a whole record",
		);
		expect(problemsOf("console.error(result.error)")).toContain(
			"prints a whole error",
		);
		expect(problemsOf("console.error(result.error.message)")).toContain(
			"prints a whole error",
		);
		expect(problemsOf("console.error([error])")).toContain(
			"prints a whole error",
		);
		expect(problemsOf("console.error(error.name, result.error.name)")).toEqual(
			[],
		);
	});

	it("reads a console reached through window, globalThis or self", () => {
		for (const global of ["window", "globalThis", "self"])
			expect(problemsOf(`${global}.console.log(publicToken)`)).toContain(
				"names a secret",
			);
	});

	it("excuses a call only when it appears exactly once", () => {
		const call = itemAt(EXCEPTIONS, 0);

		const findings = [
			{ where: "a:1", file: call.file, call: call.call, problems: call.allows },
		];

		expect(excuse(findings)).toHaveLength(1);
		expect(excuse([...findings, ...findings])).toHaveLength(0);
		expect(excuse([])).toHaveLength(0);
	});

	it("covers the service worker and every first-party script under public, not the vendored ones", () => {
		const files = appFiles().map(({ file }) => file);
		expect(files).toContain("public/sw.js");
		expect(files.some((file) => file.startsWith("public/js/"))).toBe(true);
		expect(files.some((file) => file.startsWith("public/vendor/"))).toBe(false);
	});

	it("flags a serialised value", () => {
		expect(problemsOf("console.log(JSON.stringify(thing))")).toContain(
			"serialises a value",
		);
	});

	it("passes fixed words, words about a token, an error's name, a count and an id", () => {
		expect(problemsOf("console.error('sorting: stopped')")).toEqual([]);
		expect(problemsOf("console.warn('the token has expired')")).toEqual([]);
		expect(
			problemsOf(
				"console.error('sync failed', error instanceof Error ? error.name : 'unknown')",
			),
		).toEqual([]);
		expect(
			problemsOf(`console.log(\`synced ${open}count} rows in ${open}ms} ms\`)`),
		).toEqual([]);
		expect(problemsOf(`console.log(\`item ${open}item.id} failed\`)`)).toEqual(
			[],
		);
		expect(problemsOf("console.log({ count: 3, ms })")).toEqual([]);
	});

	it("ignores a console call in a comment or in a string, and still reads the code around them", () => {
		expect(problemsOf("// console.log(token)\nconst a = 1;")).toEqual([]);
		expect(problemsOf("/* console.log(token) */ const a = 1;")).toEqual([]);
		expect(problemsOf("const s = 'console.log(token)';")).toEqual([]);
		expect(problemsOf(`const s = \`console.log(${open}x}) token\`;`)).toEqual(
			[],
		);
		expect(problemsOf("// note\nconsole.log(token)")).toContain(
			"names a secret",
		);
		expect(
			problemsOf(`const s = \`${open}f(console.log(token))}\`;`),
		).toContain("names a secret");
	});

	it("checks the calls to a declared wrapper like console calls, in its own file only", () => {
		const code = `refuse('no header'); refuse(\`failed (${open}error.message})\`)`;
		expect(auditSource("src/access.ts", code).map((f) => f.problems)).toEqual([
			[],
			["prints a whole error"],
		]);
		expect(auditSource("src/other.ts", code)).toEqual([]);
	});

	it("reads a call whose arguments hold parentheses and quoted brackets", () => {
		const calls = auditSource(
			"src/x.ts",
			"console.error(f(')'), 'a)b'); console.log('next')",
		);

		expect(calls.map((c) => c.call)).toEqual([
			"console.error(f(')'), 'a)b')",
			"console.log('next')",
		]);
	});
});

describe("what the app logs", () => {
	const files = appFiles();
	const findings = files.flatMap(({ file, text }) => auditSource(file, text));
	const excusedFindings = excuse(findings);
	const excused = (finding: Finding) => excusedFindings.includes(finding);

	it("finds the log calls it is checking, client scripts included", () => {
		expect(findings.length).toBeGreaterThan(30);
		expect(files.some(({ file }) => file.startsWith("public/js/"))).toBe(true);
		expect(files.some(({ file }) => file.startsWith("src/"))).toBe(true);
	});

	it("never names a secret or a transaction detail, or passes a whole record or error", () => {
		const offenders = findings.filter(
			(finding) => finding.problems.length > 0 && !excused(finding),
		);

		expect(
			offenders.map(
				(f) => `${f.where}: ${f.problems.join(", ")}: ${f.call.slice(0, 80)}`,
			),
		).toEqual([]);
	});

	it("keeps each exception only while the exact call it excuses appears once and still breaks the rule", () => {
		const stale = EXCEPTIONS.filter(
			(e) =>
				findings.filter(
					(f) =>
						f.file === e.file && f.call === e.call && f.problems.length > 0,
				).length !== 1,
		);

		expect(stale.map((e) => e.file)).toEqual([]);
	});
});
