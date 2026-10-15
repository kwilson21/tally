import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { HowFoot } from "../src/views/how-link";
import { Layout } from "../src/views/layout";

// The keys (#72, decisions 109 and 118): the keys sheet, the keys' details in the foot and in More, the keys'
// targets and the rows keyboard.js moves between. Routes are read as HTML, the way a browser gets them.

/** Attribute values as the browser reads them: Hono escapes & and > in attributes. */
const decodeAttributes = (text: string) =>
	text.replaceAll("&amp;", "&").replaceAll("&gt;", ">");

async function page(path: string) {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return decodeAttributes(await res.text());
}

/** The keys container: the element Layout draws before the toasts, with whatever it holds. */
function keysRegion(html: string) {
	const start = html.indexOf('<div id="keys"');
	const end = html.indexOf('<div id="toasts"', start);
	return start === -1 || end === -1 ? "" : html.slice(start, end);
}

/** The month before the demo's current one: Home has a next-month link there. */
function previousMonth() {
	return monthsBefore(todayIn(DEFAULT_TIME_ZONE).slice(0, 7), 1);
}

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

afterEach(() => {
	Object.assign(env, { DEMO: "true" });
});

describe("keyboard.js and the keys container (decision 109)", () => {
	it("loads keyboard.js once, as a module, on every page", async () => {
		for (const path of ["/", "/transactions", "/bills", "/more"]) {
			const html = await page(path);
			expect(
				html.split('<script src="/js/keyboard.js" type="module">'),
			).toHaveLength(2);
		}
	});

	it("draws an empty #keys container on every page, outside #main, so a sheet swap never moves the page", async () => {
		for (const path of ["/", "/transactions", "/more"]) {
			const html = await page(path);
			expect(html).toContain('<div id="keys"></div>');
			expect(html.indexOf('<div id="keys"')).toBeGreaterThan(
				html.indexOf('<main id="main"'),
			);
		}
	});
});

describe("the keys sheet (?keys, P128 C)", () => {
	it("draws the keys sheet over Home, as a modal dialog titled Keyboard shortcuts", async () => {
		const region = keysRegion(await page("/?keys"));
		expect(region).toContain('role="dialog"');
		expect(region).toContain('aria-labelledby="keys-title"');
		expect(region).toContain("data-sheet");
		expect(region).toMatch(
			/<h2 id="keys-title" class="font-serif text-2xl font-semibold tracking-tight">Keyboard shortcuts<\/h2>/,
		);
	});

	it("draws the ledger of keys in the sheet, each key in a kbd", async () => {
		const region = keysRegion(await page("/?keys"));
		for (const words of [
			"Search transactions",
			"Show these keys",
			"Next row / previous row",
			"Open the row",
			"Previous month / next month",
			"Undo it, while its toast shows",
		])
			expect(region).toContain(words);
		expect(region).toContain("<kbd");
		expect(region).toContain("Escape closes it.");
	});

	it("draws the same sheet over Transactions", async () => {
		const region = keysRegion(await page("/transactions?keys"));
		expect(region).toContain('id="keys-title"');
	});

	it("closes to the same page without keys: Cancel and the backdrop both drop the keys", async () => {
		const region = keysRegion(await page("/transactions?month=2026-09&keys"));
		// The backdrop and Cancel both name the page without keys, and swap #keys with the page's own empty one.
		expect(region).toContain('href="/transactions?month=2026-09"');
		expect(region.match(/href="\/transactions\?month=2026-09"/g)).toHaveLength(
			2,
		);
		expect(region).toContain('hx-target="#keys"');
		expect(region).toContain('hx-select="#keys"');
		expect(region).not.toMatch(/href="[^"]*keys[^"]*"/);
	});

	it("draws no sheet for a page without keys", async () => {
		expect(keysRegion(await page("/"))).not.toContain("keys-title");
	});
});

describe("the keys' details and More's row", () => {
	it("puts a closed Keyboard shortcuts details under How this works on desktop, at the foot of a page with it", async () => {
		for (const path of ["/", "/transactions", "/bills"]) {
			const html = await page(path);
			expect(html).toMatch(
				/<div class="mt-2 hidden lg:block"><details class="group"><summary[^>]*>[\s\S]*?Keyboard shortcuts/,
			);
			expect(html).toContain("How this works");
		}
	});

	it("ends More's contents with a Keyboard shortcuts row, drawn below lg only", async () => {
		const html = await page("/more");
		expect(html).toMatch(
			/<li class="lg:hidden"><details class="group"><summary[^>]*>[\s\S]*?Keyboard shortcuts/,
		);
		expect(html.indexOf("Keyboard shortcuts")).toBeGreaterThan(
			html.indexOf("Tally works"),
		);
	});
});

describe("the rows keyboard.js moves between", () => {
	it("marks a transaction row, a bill row and Home's category row as a row a person opens", async () => {
		expect(await page("/transactions")).toContain("data-row");
		expect(await page("/")).toContain("data-row");
		expect(await page("/bills")).toContain("data-row");
	});
});

describe("the keys' targets name their keys (aria-keyshortcuts)", () => {
	it("names / on the transactions search field", async () => {
		expect(await page("/transactions")).toMatch(
			/<input[^>]*id="q"[^>]*aria-keyshortcuts="\/"|<input[^>]*aria-keyshortcuts="\/"[^>]*id="q"/,
		);
	});

	it("names the arrows on Home's next-month link", async () => {
		const html = await page(`/?month=${previousMonth()}`);
		expect(html).toContain('aria-keyshortcuts="ArrowRight"');
	});

	it("focuses the search field when ?focus=search asks for it", async () => {
		expect(await page("/transactions?focus=search")).toMatch(
			/<input[^>]*id="q"[^>]*autofocus|<input[^>]*autofocus[^>]*id="q"/,
		);
	});
});

describe("the demo and the family's app", () => {
	// The family's app signs in through Cloudflare Access before any page, so its shell is drawn directly: the same
	// Layout and HowFoot every page uses, with demo off.
	it("draw the same keys, with keyboard.js, the sheet and the foot's details", async () => {
		const shell = String(
			await Layout({
				demo: false,
				currentPath: "/?keys",
				children: HowFoot({ section: "budget" }),
			}).toString(),
		);
		expect(shell).toContain('<script src="/js/keyboard.js" type="module">');
		expect(keysRegion(shell)).toContain("keys-title");
		expect(shell).toMatch(
			/<div class="mt-2 hidden lg:block"><details class="group">/,
		);
	});
});
