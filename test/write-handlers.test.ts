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

const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;
const TESTS = import.meta.glob("./*.test.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;
const ROADMAP = import.meta.glob("../ROADMAP.md", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/** Every write route the running app has registered, read from Hono's route table, as "METHOD path". */
function registeredWrites(routes: { method: string; path: string }[]) {
	const found = new Set<string>();
	const problems: string[] = [];
	for (const r of routes) {
		if (WRITES.has(r.method)) found.add(key(r));
		// app.use("*") middleware is "ALL" on a wildcard path. A named path with ALL could take a write unlisted.
		else if (r.method === "ALL" && !r.path.endsWith("*"))
			problems.push(
				`${key(r)} takes every method; register each method on its own`,
			);
	}
	return { found, problems };
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
				if (!handlerFile.includes(name))
					problems.push(
						`${k} is converted but ${e.file} does not import ${name}`,
					);
				if (stories === undefined)
					problems.push(
						`${k} is converted but its stories test ${e.stories} is not in test/`,
					);
				else if (!stories.includes(name))
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
	const { found, problems: shapes } = registeredWrites(app.routes);

	it("holds for the real app: every write route is listed, every listed route exists", () => {
		expect(shapes).toEqual([]);
		expect(ratchetProblems(found, handlers as List, SOURCES, TESTS)).toEqual(
			[],
		);
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
			"../src/routes/x.tsx": 'import { go } from "../rules/x";',
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
		).toMatch(/x.tsx does not import rules\/x/);
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
		).toEqual([]);
	});

	it("shows the same countdown in ROADMAP.md as the list gives", () => {
		const text = ROADMAP["../ROADMAP.md"] ?? "";
		const todo = (handlers as List).handlers.filter(
			(e) => e.status !== "exempt",
		);
		const left = todo.filter((e) => e.status === "legacy").length;
		expect(text).toContain(
			`Back-end cutover: ${left} of ${todo.length} handlers remain`,
		);
		for (const area of new Set(todo.map((e) => e.area))) {
			const mine = todo.filter((e) => e.area === area);
			const mineLeft = mine.filter((e) => e.status === "legacy").length;
			expect(text, area).toContain(
				`| ${area} | ${mineLeft} | ${mine.length} |`,
			);
		}
	});
});
