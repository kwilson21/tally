import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { hxTrigger } from "../src/htmx";

// An HX-Trigger header is plain ASCII: a toast's curly apostrophe or minus sign is written as a \uXXXX escape,
// which JSON reads back to the same words, so htmx and public/js/toast.js show the same text (#521).

const ASCII = /^[\x20-\x7e]*$/;
const BASE = "http://tally.test";

describe("hxTrigger", () => {
	it("writes a curly apostrophe and a minus sign as ASCII escapes that read back to the same words", () => {
		const trigger = {
			toast: { message: "Mum’s budget is −$5.00", type: "success" },
			announce: "Mum’s budget is −$5.00 a month.",
		};
		const header = hxTrigger(trigger);
		expect(header).toMatch(ASCII);
		expect(header).toContain("\\u2019");
		expect(header).toContain("\\u2212");
		expect(JSON.parse(header)).toEqual(trigger);
	});

	it("writes a character outside the Basic Multilingual Plane as a pair of escapes", () => {
		const header = hxTrigger({ announce: "Nice 😀" });
		expect(header).toMatch(ASCII);
		expect(header).toContain("\\ud83d\\ude00");
		expect(JSON.parse(header)).toEqual({ announce: "Nice 😀" });
	});

	it("writes ASCII words exactly as JSON.stringify does", () => {
		const trigger = { toast: { message: 'Saved "Rent"', type: "success" } };
		expect(hxTrigger(trigger)).toBe(JSON.stringify(trigger));
	});
});

// Every source file as text. A quoted "HX-Trigger" (or HX-Trigger-After-Swap or -After-Settle) in src is a header set
// (c.header, headers.set or an object key), and its value must come straight from hxTrigger, not from JSON.stringify or a variable.
const SOURCES = import.meta.glob(["../src/**/*.{ts,tsx}"], {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const HEADER_NAME = /"HX-Trigger(?:-After-(?:Swap|Settle))?"/g;
const HELPED = /"HX-Trigger(?:-After-(?:Swap|Settle))?"\s*[,:]\s*hxTrigger\(/y;

/** The "file:line" of every quoted HX-Trigger header whose value does not start with a call to hxTrigger, and how many there are. */
function unhelpedTriggerSites(files: Record<string, string>) {
	let sites = 0;
	const unhelped: string[] = [];
	for (const [file, text] of Object.entries(files)) {
		for (const match of text.matchAll(HEADER_NAME)) {
			sites++;
			const at = match.index ?? 0;
			HELPED.lastIndex = at;
			if (!HELPED.test(text)) {
				unhelped.push(`${file}:${text.slice(0, at).split("\n").length}`);
			}
		}
	}
	return { sites, unhelped };
}

describe("HX-Trigger headers in src", () => {
	it("are all set through hxTrigger", () => {
		const { sites, unhelped } = unhelpedTriggerSites(SOURCES);
		expect(sites).toBeGreaterThan(30);
		expect(unhelped).toEqual([]);
	});

	it("are checked for real: a header set with JSON.stringify is found, under any of the three names", () => {
		const { sites, unhelped } = unhelpedTriggerSites({
			"src/example.tsx": 'c.header("HX-Trigger", JSON.stringify({}));',
			"src/after.tsx": 'c.header("HX-Trigger-After-Swap", JSON.stringify({}));',
			"src/helped.tsx": 'c.header("HX-Trigger-After-Settle", hxTrigger({}));',
		});
		expect(sites).toBe(3);
		expect(unhelped).toEqual(["src/example.tsx:1", "src/after.tsx:1"]);
	});
});

describe("a route's HX-Trigger header", () => {
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

	it("is ASCII when the toast holds a curly apostrophe, and reads back to the same words", async () => {
		const res = await exports.default.fetch(`${BASE}/transactions/cash`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				date: todayIn(DEFAULT_TIME_ZONE),
				amount: "20.45",
				merchant: "Ada’s café",
				category: "1",
			}),
		});
		expect(res.status).toBe(200);
		const header = res.headers.get("HX-Trigger") ?? "";
		expect(header).toMatch(ASCII);
		expect(JSON.parse(header)).toEqual({
			toast: { message: "Added Ada’s café", type: "success" },
			announce: "Added $20.45 cash spending at Ada’s café.",
		});
	});
});
