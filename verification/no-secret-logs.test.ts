import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAst } from "vitest/node";

// The rule (CLAUDE.md): never log tokens or transaction details. A log line is fixed words and, at most, an error's name,
// a count or an id the person already sees. This parses every file of the app's own code (src, and the client scripts in
// public/js that run in the browser), finds every call to a console method, and fails on an argument that names a secret
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
		["public/js", /\.js$/],
	] as const) {
		for (const entry of readdirSync(path.join(ROOT, dir), {
			recursive: true,
		}) as string[]) {
			if (!pattern.test(entry) || entry.endsWith(".d.ts")) continue;
			const file = path.posix.join(dir, entry.split(path.sep).join("/"));
			files.push({ file, text: readFileSync(path.join(ROOT, file), "utf8") });
		}
	}
	return files;
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

type Node = {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
};
const isNode = (value: unknown): value is Node =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Node).type === "string";

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

const name = (node: unknown): string | null =>
	isNode(node) && node.type === "Identifier" ? String(node.name) : null;

/** The name a property is reached by: `.x`, or `["x"]` with a quoted name. */
function propertyName(member: Node): string | null {
	const property = member.property;
	if (!member.computed) return name(property);
	return isNode(property) &&
		property.type === "Literal" &&
		typeof property.value === "string"
		? property.value
		: null;
}

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

/** An identifier or a plain path (`a.b.c`) whose last name is in `set`. */
function endsInName(node: Node, set: Set<string>): boolean {
	if (node.type === "Identifier") return set.has(String(node.name));
	if (node.type === "MemberExpression")
		return set.has(propertyName(node) ?? "");
	return false;
}

/** A whole record: a bare record name, or an object literal that holds one. */
function wholeRecord(node: Node): boolean {
	if (endsInName(node, RECORD_NAMES)) return true;
	if (node.type === "ObjectExpression")
		return (node.properties as Node[]).some(
			(property) =>
				isNode(property.value) &&
				property.type === "Property" &&
				endsInName(property.value, RECORD_NAMES),
		);
	return false;
}

/** A whole error or its message or stack: `error`, `error.message`, `String(error)`. */
function wholeError(node: Node): boolean {
	if (name(node) !== null) return ERROR_NAMES.has(name(node) as string);
	if (node.type === "MemberExpression")
		return (
			ERROR_NAMES.has(name(node.object) ?? "") &&
			["message", "stack"].includes(propertyName(node) ?? "")
		);
	if (node.type === "CallExpression")
		return (
			name(node.callee) === "String" &&
			(node.arguments as Node[]).some((argument) =>
				ERROR_NAMES.has(name(argument) ?? ""),
			)
		);
	return false;
}

/** The reasons one argument of a log call breaks the rule. */
function argumentProblems(argument: Node): string[] {
	const found = new Set<string>();
	const names = namesIn(argument);
	if (names.some((n) => SECRET.test(n))) found.add("names a secret");
	if (names.some((n) => TRANSACTION.test(n)))
		found.add("names part of a transaction");
	for (const node of descendants(argument)) {
		// Only the argument itself, the parts of a template, and the values of an object literal can be "whole".
		const direct =
			node === argument ||
			node.type === "TemplateLiteral" ||
			node.type === "ObjectExpression";
		if (!direct && node.type !== "MemberExpression") continue;
		const candidates: Node[] =
			node.type === "TemplateLiteral"
				? (node.expressions as Node[])
				: node.type === "ObjectExpression"
					? (node.properties as Node[])
							.map((property) => property.value)
							.filter(isNode)
					: [node];
		for (const candidate of candidates) {
			if (wholeError(candidate)) found.add("prints a whole error");
			if (wholeRecord(candidate) && candidate !== argument)
				found.add("passes a whole record");
		}
		if (node === argument && wholeRecord(node))
			found.add("passes a whole record");
		if (
			node.type === "CallExpression" &&
			node.callee &&
			isNode(node.callee) &&
			node.callee.type === "MemberExpression" &&
			name(node.callee.object) === "JSON" &&
			propertyName(node.callee) === "stringify"
		)
			found.add("serialises a value");
	}
	return [...found];
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
	const program = parseAst(text, { lang }) as unknown as Node;
	const wrappers = WRAPPERS.filter((w) => file === w.file).map((w) => w.name);
	const findings: Finding[] = [];
	for (const node of descendants(program)) {
		if (node.type !== "CallExpression" || !isNode(node.callee)) continue;
		const callee = node.callee;
		const isConsole =
			callee.type === "MemberExpression" && name(callee.object) === "console";
		const isWrapper = wrappers.includes(name(callee) ?? "");
		if (!isConsole && !isWrapper) continue;
		const problems = [
			...new Set(
				(node.arguments as Node[]).flatMap((argument) =>
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
	const excused = (finding: Finding) =>
		EXCEPTIONS.find(
			(e) =>
				e.file === finding.file &&
				e.call === finding.call &&
				finding.problems.every((p) => e.allows.includes(p)),
		);

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

	it("keeps each exception only while the exact call it excuses still breaks the rule", () => {
		const stale = EXCEPTIONS.filter(
			(e) =>
				!findings.some(
					(f) =>
						f.file === e.file && f.call === e.call && f.problems.length > 0,
				),
		);
		expect(stale.map((e) => e.file)).toEqual([]);
	});
});
