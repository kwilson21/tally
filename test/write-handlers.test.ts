import { describe, expect, it } from "vitest";
import handlers from "../docs/write-handlers.json";
import { app } from "../src/index";

// The back-end cutover ratchet (decision 187): every write route is listed once in docs/write-handlers.json as legacy,
// converted or exempt. The legacy count may only go down, and a converted route must show its rule and its stories.

type Entry = {
	method: string;
	path: string;
	file: string;
	area: string;
	status: string;
	reason?: string;
	rule?: string;
	stories?: string;
};

type List = { legacyBaseline: number; handlers: Entry[] };

const LIST: List = handlers;

const SOURCES = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
});

const TESTS = import.meta.glob<string>("./**/*.test.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
});

const ROADMAP = import.meta.glob<string>("../ROADMAP.md", {
	query: "?raw",
	import: "default",
	eager: true,
});

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The middleware the app registers for every method. Any other ALL route could take a write without being listed.
const KNOWN_MIDDLEWARE = new Set(["/*", "/design-system/*"]);
const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/** Every write route the running app has registered, read from Hono's route table, as "METHOD path". */
function registeredWrites(routes: { method: string; path: string }[]) {
	const found = new Set<string>();
	const problems: string[] = [];

	for (const r of routes) {
		if (WRITES.has(r.method)) {
			// Two registrations of one route (an old handler left beside a new one) would count as one.
			if (found.has(key(r)))
				problems.push(`${key(r)} is registered more than once`);
			found.add(key(r));
		} else if (r.method === "ALL" && !KNOWN_MIDDLEWARE.has(r.path))
			problems.push(
				`${key(r)} takes every method; register each method on its own`,
			);
	}

	return { found, problems };
}

/** True when the text really imports the module (a "from" or import() specifier), not a comment or a longer sibling name. */
function importsModule(text: string, name: string) {
	const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

	for (const m of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
		const spec = (m[1] ?? "")
			.replace(/^(\.{1,2}\/)+/, "")
			.replace(/^src\//, "")
			.replace(/\.tsx?$/, "");

		if (spec === name) return true;
	}

	return false;
}

/** What is wrong with the list, as plain sentences. Empty means the ratchet holds. */
function ratchetProblems(
	registered: Set<string>,
	list: List,
	sources: Record<string, string>,
	tests: Record<string, string>,
) {
	const problems: string[] = [];
	const listed = new Set<string>();

	for (const e of list.handlers) {
		const k = key(e);

		if (listed.has(k)) problems.push(`${k} is listed twice`);
		listed.add(k);

		if (!["legacy", "converted", "exempt"].includes(e.status))
			problems.push(`${k} has status "${e.status}"`);

		if (!registered.has(k))
			problems.push(`${k} is listed but no handler has it`);

		if (e.status === "exempt" && !e.reason?.trim())
			problems.push(`${k} is exempt without a reason`);

		if (e.status === "converted") {
			const hasRule = e.rule !== undefined && `../${e.rule}` in sources;

			const stories = e.stories
				? tests[`./${e.stories.replace(/^test\//, "")}`]
				: undefined;

			if (!hasRule)
				problems.push(
					`${k} is converted but its rule module ${e.rule} is not in src/`,
				);
			else {
				const name = (e.rule ?? "")
					.replace(/^src\//, "")
					.replace(/\.tsx?$/, "");

				const handlerFile = sources[`../src/routes/${e.file}`] ?? "";

				if (!handlerFile.includes(e.path))
					problems.push(
						`${k} is converted but ${e.file} does not contain the path ${e.path}`,
					);

				if (!importsModule(handlerFile, name))
					problems.push(
						`${k} is converted but ${e.file} does not import ${name}`,
					);

				if (stories === undefined)
					problems.push(
						`${k} is converted but its stories test ${e.stories} is not in test/`,
					);
				else if (!importsModule(stories, name))
					problems.push(
						`${k} is converted but ${e.stories} does not import ${name}`,
					);
			}
		}
	}

	for (const k of registered)
		if (!listed.has(k))
			problems.push(`${k} is a write handler that is not on the list`);
	const legacy = list.handlers.filter((e) => e.status === "legacy").length;

	if (legacy !== list.legacyBaseline)
		problems.push(
			legacy > list.legacyBaseline
				? `${legacy} legacy handlers is more than the baseline ${list.legacyBaseline}`
				: `${legacy} legacy handlers is fewer than the baseline ${list.legacyBaseline}; lower the baseline in this pull request`,
		);

	return problems;
}

const entry = (over: Partial<Entry> = {}): Entry => ({
	method: "POST",
	path: "/x",
	file: "x.tsx",
	area: "x",
	status: "legacy",
	...over,
});

const one = (e: Entry, baseline = 1): List => ({
	legacyBaseline: baseline,
	handlers: [e],
});

describe("the write-handler ratchet", () => {
	const { found, problems: malformed } = registeredWrites(app.routes);

	it("holds for the real app: every write route is listed, every listed route exists", () => {
		expect(malformed).toEqual([]);
		expect(ratchetProblems(found, LIST, SOURCES, TESTS)).toEqual([]);
	});

	it("fails when a write handler is not on the list", () => {
		const p = ratchetProblems(
			new Set(["POST /x", "POST /new"]),
			one(entry()),
			SOURCES,
			TESTS,
		);

		expect(p).toEqual(["POST /new is a write handler that is not on the list"]);
	});

	it("fails when a list entry matches no handler", () => {
		const p = ratchetProblems(new Set(), one(entry()), SOURCES, TESTS);
		expect(p).toEqual(["POST /x is listed but no handler has it"]);
	});

	it("fails when the legacy count is above the baseline, and asks for a lower baseline when it is below", () => {
		const reg = new Set(["POST /x"]);
		expect(ratchetProblems(reg, one(entry(), 0), SOURCES, TESTS)[0]).toMatch(
			/more than the baseline/,
		);
		expect(
			ratchetProblems(
				reg,
				one(entry({ status: "exempt", reason: "r" }), 1),
				SOURCES,
				TESTS,
			)[0],
		).toMatch(/lower the baseline/);
	});

	it("fails when a converted entry has no rule module, no stories test, or neither imports the rule", () => {
		const reg = new Set(["POST /x"]);

		const converted = entry({
			status: "converted",
			rule: "src/rules/x.ts",
			stories: "test/x-stories.test.ts",
		});

		const list = one(converted, 0);
		expect(ratchetProblems(reg, list, {}, {})[0]).toMatch(
			/rule module src\/rules\/x.ts is not in src\//,
		);

		const src = {
			"../src/rules/x.ts": "",
			"../src/routes/x.tsx":
				'import { go } from "../rules/x"; app.post("/x", go);',
		};

		expect(ratchetProblems(reg, list, src, {})[0]).toMatch(
			/stories test test\/x-stories.test.ts is not in test\//,
		);
		expect(
			ratchetProblems(reg, list, src, { "./x-stories.test.ts": "nothing" })[0],
		).toMatch(/does not import rules\/x/);
		expect(
			ratchetProblems(reg, list, src, {
				"./x-stories.test.ts": 'from "../src/rules/x"',
			}),
		).toEqual([]);
		expect(
			ratchetProblems(
				reg,
				list,
				{ ...src, "../src/routes/x.tsx": "" },
				{ "./x-stories.test.ts": 'from "../src/rules/x"' },
			)[0],
		).toMatch(/x.tsx does not contain the path \/x/);

		const pay = entry({
			path: "/pay",
			status: "converted",
			rule: "src/rules/x.ts",
			stories: "test/x-stories.test.ts",
		});

		const stories = { "./x-stories.test.ts": 'from "../src/rules/x"' };
		expect(
			ratchetProblems(new Set(["POST /pay"]), one(pay, 0), src, stories),
		).toEqual([
			"POST /pay is converted but x.tsx does not contain the path /pay",
		]);
	});

	it("fails when one write route is registered twice", () => {
		const twice = [
			{ method: "POST", path: "/x" },
			{ method: "POST", path: "/x" },
		];

		expect(registeredWrites(twice).problems).toEqual([
			"POST /x is registered more than once",
		]);
	});

	it("fails when an exempt entry has no reason, or a route takes every method", () => {
		const reg = new Set(["POST /x"]);
		expect(
			ratchetProblems(reg, one(entry({ status: "exempt" }), 0), SOURCES, TESTS),
		).toEqual(["POST /x is exempt without a reason"]);
		expect(
			registeredWrites([{ method: "ALL", path: "/pay" }]).problems,
		).toHaveLength(1);
		expect(
			registeredWrites([{ method: "ALL", path: "/pay/*" }]).problems,
		).toHaveLength(1);
		expect(registeredWrites([{ method: "ALL", path: "/*" }]).problems).toEqual(
			[],
		);
	});

	it("counts a module only when it is imported, not named in a comment or as a longer sibling", () => {
		expect(
			importsModule('import { a } from "../rules/pay";', "rules/pay"),
		).toBe(true);
		expect(importsModule('await import("../src/rules/pay")', "rules/pay")).toBe(
			true,
		);
		expect(importsModule('// from "../rules/pay"', "rules/pay")).toBe(false);
		expect(
			importsModule('import { a } from "../rules/payment";', "rules/pay"),
		).toBe(false);
	});

	it("shows the same countdown in ROADMAP.md as the list gives", () => {
		const text = ROADMAP["../ROADMAP.md"] ?? "";

		const todo = LIST.handlers.filter((e) => e.status !== "exempt");

		const exempt = LIST.handlers.length - todo.length;
		expect(text).toContain(`Exempt routes (${exempt}) are not counted`);
		const left = todo.filter((e) => e.status === "legacy").length;
		expect(text).toContain(
			`Back-end cutover: ${left} of ${todo.length} handlers remain`,
		);

		// The section's whole table, so a row left behind for a finished area fails too.
		const section =
			text.split("## Back-end cutover")[1]?.split("\n## ")[0] ?? "";

		const shown = [
			...section.matchAll(/^\| (\S+) \| (\d+) \| (\d+) \|$/gm),
		].map((m) => `${m[1]} ${m[2]} ${m[3]}`);

		const expected = [...new Set(todo.map((e) => e.area))].map((area) => {
			const mine = todo.filter((e) => e.area === area);

			return `${area} ${mine.filter((e) => e.status === "legacy").length} ${mine.length}`;
		});

		expect(shown.sort()).toEqual(expected.sort());
	});
});
