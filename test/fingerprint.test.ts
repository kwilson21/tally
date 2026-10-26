import { describe, expect, it } from "vitest";
import {
	changedParts,
	cleanSelector,
	fingerprintOf,
	needsCapture,
	normalizeDom,
} from "../scripts/fingerprint.mjs";

// Two v4 UUIDs, as crypto.randomUUID() makes them. Each load of a page draws new ones.
const FIRST = "3f1c9a2e-7b4d-4c1a-9e8f-0a1b2c3d4e5f";
const SECOND = "b7d2e4f1-0c3a-4d5e-8f6a-1b2c3d4e5f60";

describe("normalizeDom", () => {
	it("makes the Add cash entry key (transactions.tsx:1772) the same on two loads", () => {
		const load = (key: string) =>
			`<form action="/transactions/cash"><input type="hidden" name="entry_key" value="${key}"></form>`;
		expect(normalizeDom(load(FIRST))).toBe(normalizeDom(load(SECOND)));
	});

	it("makes the split sheet's sheet id and refund ids (split-form.tsx:267) the same on two loads", () => {
		const load = (sheet: string) =>
			`<input type="hidden" name="sheet" value="${sheet}"><div id="refund-${sheet}-r1-part-0"></div>`;
		expect(normalizeDom(load(FIRST))).toBe(normalizeDom(load(SECOND)));
	});

	it("keeps a changed text node different", () => {
		const groceries = "<h2>Groceries</h2>";
		const gas = "<h2>Gas</h2>";
		expect(normalizeDom(groceries)).not.toBe(normalizeDom(gas));
	});

	it("keeps a changed attribute different", () => {
		const bill = `<a href="/transactions/110" data-id="${FIRST}">Local Bakery</a>`;
		const other = `<a href="/transactions/111" data-id="${FIRST}">Local Bakery</a>`;
		expect(normalizeDom(bill)).not.toBe(normalizeDom(other));
	});

	it("makes the attribute order the same on two loads: the transaction sheet's inert and htmx marks (/transactions/110, #785)", () => {
		// htmx and sheet.js set these in whichever order their scripts run, so two loads can list them differently.
		const htmxFirst =
			'<form data-htmx-powered="true" inert="" data-sheet-inert="">Edit</form>';
		const inertFirst =
			'<form inert="" data-sheet-inert="" data-htmx-powered="true">Edit</form>';
		expect(normalizeDom(htmxFirst)).toBe(normalizeDom(inertFirst));
	});

	it("keeps a changed attribute value different even when the attributes are in another order", () => {
		const one = '<a href="/x" data-k="1">Edit</a>';
		const two = '<a data-k="2" href="/x">Edit</a>';
		expect(normalizeDom(one)).not.toBe(normalizeDom(two));
	});

	it("leaves a <script>'s raw text alone, so attribute-like text inside it stays as it is", () => {
		const script = `<script>var t = '<i z="1" a="2">';</script>`;
		expect(normalizeDom(script)).toBe(script);
	});

	it("leaves a value that is not a v4 UUID as it is", () => {
		const v1 = "00000000-0000-1000-8000-000000000000";
		expect(normalizeDom(`<i data-id="${v1}"></i>`)).toContain(v1);
	});
});

describe("fingerprintOf", () => {
	const dom = "<main><h1>Home</h1></main>";
	const APP_JS = { path: "/assets/app.js", sha256: "aa" };
	const HTMX = { path: "/vendor/htmx.min.js", sha256: "bb" };
	const assets = [APP_JS, HTMX];
	const css = [".used{color:red}", "@media (min-width:1px){.used{margin:0}}"];

	it("is the same whatever order the assets were loaded in", async () => {
		expect(await fingerprintOf({ dom, assets, css })).toBe(
			await fingerprintOf({ dom, assets: [...assets].reverse(), css }),
		);
	});

	it("is the same for two loads whose only difference is a v4 UUID", async () => {
		const load = (key: string) =>
			`<main><input name="entry_key" value="${key}"></main>`;
		expect(await fingerprintOf({ dom: load(FIRST), assets, css })).toBe(
			await fingerprintOf({ dom: load(SECOND), assets, css }),
		);
	});

	it("changes when an asset's content changes", async () => {
		const changed = [APP_JS, { ...HTMX, sha256: "bc" }];
		expect(await fingerprintOf({ dom, assets: changed, css })).not.toBe(
			await fingerprintOf({ dom, assets, css }),
		);
	});

	it("changes when an asset's path changes", async () => {
		const moved = [{ ...APP_JS, path: "/assets/app.v2.js" }, HTMX];
		expect(await fingerprintOf({ dom, assets: moved, css })).not.toBe(
			await fingerprintOf({ dom, assets, css }),
		);
	});

	it("changes when the DOM changes", async () => {
		expect(
			await fingerprintOf({ dom: "<main><h1>Gas</h1></main>", assets, css }),
		).not.toBe(await fingerprintOf({ dom, assets, css }));
	});

	it("changes when a css string changes", async () => {
		const changed = [".used{color:blue}", css[1]];
		expect(await fingerprintOf({ dom, assets, css: changed })).not.toBe(
			await fingerprintOf({ dom, assets, css }),
		);
	});

	it("changes when two css strings swap order, since the order of CSS matters", async () => {
		expect(
			await fingerprintOf({ dom, assets, css: [...css].reverse() }),
		).not.toBe(await fingerprintOf({ dom, assets, css }));
	});

	it("keeps a css string and a dom string from running together", async () => {
		expect(await fingerprintOf({ dom: "ab", assets, css: [] })).not.toBe(
			await fingerprintOf({ dom: "a", assets, css: ["b"] }),
		);
		expect(await fingerprintOf({ dom: "<i>a</i>", assets, css: [] })).not.toBe(
			await fingerprintOf({ dom: "<i>a</i>", assets, css: ["<i>a</i>"] }),
		);
	});

	it("keeps a path and a hash from running together", async () => {
		// Joined with no separator, both read "/abc": only the field boundaries tell them apart.
		expect(
			await fingerprintOf({
				dom,
				assets: [{ path: "/a", sha256: "bc" }],
				css,
			}),
		).not.toBe(
			await fingerprintOf({
				dom,
				assets: [{ path: "/ab", sha256: "c" }],
				css,
			}),
		);
	});

	it("is a 64-character lowercase hex SHA-256", async () => {
		expect(await fingerprintOf({ dom, assets, css })).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("changedParts", () => {
	const dom = "<main><h1>Home</h1></main>";
	const assets = [
		{ path: "/assets/app.js", sha256: "aa" },
		{ path: "/vendor/htmx.min.js", sha256: "bb" },
	];
	const css = [".used{color:red}", "@media (min-width:1px){.used{margin:0}}"];
	const head = { dom, assets, css };

	it("names no part when two loads are the same", () => {
		expect(changedParts(head, { dom, assets, css })).toEqual([]);
	});

	it("names only the DOM when only the DOM differs", () => {
		expect(
			changedParts(head, { dom: "<main><h1>Gas</h1></main>", assets, css }),
		).toEqual(["dom"]);
	});

	it("names only the assets when an asset's hash differs", () => {
		const changed = [assets[0], { ...assets[1], sha256: "bc" }];
		expect(changedParts(head, { dom, assets: changed, css })).toEqual([
			"assets",
		]);
	});

	it("names only the css when a css string differs", () => {
		expect(
			changedParts(head, { dom, assets, css: [".used{color:blue}", css[1]] }),
		).toEqual(["css"]);
	});

	it("names the css when two css strings swap order", () => {
		expect(
			changedParts(head, { dom, assets, css: [...css].reverse() }),
		).toEqual(["css"]);
	});

	it("names the changed parts in the order dom, assets, css", () => {
		expect(
			changedParts(head, {
				dom: "<main>Gas</main>",
				assets: [assets[0]],
				css: [],
			}),
		).toEqual(["dom", "assets", "css"]);
		expect(
			changedParts(head, { dom: "<main>Gas</main>", assets, css: [] }),
		).toEqual(["dom", "css"]);
	});

	it("names no part for a v4 UUID or an asset order change, as fingerprintOf ignores them", () => {
		const load = (key: string) => ({
			dom: `<main><input name="entry_key" value="${key}"></main>`,
			assets: [...assets].reverse(),
			css,
		});
		expect(changedParts(load(FIRST), load(SECOND))).toEqual([]);
	});
});

describe("needsCapture", () => {
	it("needs a capture when the fingerprints differ", () => {
		expect(
			needsCapture({
				head: { ok: true, fingerprint: "new" },
				base: { ok: true, fingerprint: "old" },
			}),
		).toBe(true);
	});

	it("needs no capture when the fingerprints match", () => {
		expect(
			needsCapture({
				head: { ok: true, fingerprint: "same" },
				base: { ok: true, fingerprint: "same" },
			}),
		).toBe(false);
	});

	it("needs a capture when the base can't show the page, even if it's a page the PR changed too", () => {
		expect(
			needsCapture({
				head: { ok: true, fingerprint: "new" },
				base: { ok: false },
			}),
		).toBe(true);
	});
});

describe("cleanSelector", () => {
	it("takes out each user-action pseudo-class", () => {
		for (const pseudo of [
			":hover",
			":focus",
			":focus-visible",
			":focus-within",
			":active",
			":visited",
		]) {
			expect(cleanSelector(`.btn${pseudo}`)).toBe(".btn");
		}
	});

	it("takes out a pseudo-element, with its argument when it has one", () => {
		expect(cleanSelector(".a::before")).toBe(".a");
		expect(cleanSelector(".a::part(x)")).toBe(".a");
		expect(cleanSelector(".a::view-transition-group(*)")).toBe(".a");
		expect(cleanSelector("input::-webkit-scrollbar")).toBe("input");
		expect(cleanSelector(".a::part(x (y))")).toBe(".a");
	});

	it("takes out the legacy single-colon pseudo-elements", () => {
		expect(cleanSelector(".a:before")).toBe(".a");
		expect(cleanSelector(".a:after")).toBe(".a");
		expect(cleanSelector("p:first-line")).toBe("p");
		expect(cleanSelector("p:first-letter")).toBe("p");
	});

	it("matches a whole name: :focus is not the start of :focus-visible, and :hover is not :hover-x", () => {
		expect(cleanSelector(".a:focus-visible")).toBe(".a");
		expect(cleanSelector(".a:focus")).toBe(".a");
		expect(cleanSelector(".a:hover-x")).toBe(".a:hover-x");
	});

	it("takes out an escaped variant's user-action pseudo-class and keeps the escaped colon", () => {
		expect(cleanSelector(".hover\\:underline:hover")).toBe(
			".hover\\:underline",
		);
		expect(cleanSelector(".focus-visible\\:ring-2:focus-visible")).toBe(
			".focus-visible\\:ring-2",
		);
	});

	it("leaves an escaped colon that is not a pseudo-class alone", () => {
		expect(cleanSelector(".md\\:flex")).toBe(".md\\:flex");
		expect(cleanSelector(".a\\ b:hover")).toBe(".a\\ b");
	});

	it("leaves attribute selectors and quoted strings alone", () => {
		expect(cleanSelector("[class*=\\:rounded-br-sheet]")).toBe(
			"[class*=\\:rounded-br-sheet]",
		);
		expect(cleanSelector('[data-x=":hover"]')).toBe('[data-x=":hover"]');
		expect(cleanSelector("[data-x=':before']")).toBe("[data-x=':before']");
	});

	it("keeps the state pseudo-classes, :has(), :not(), :is(), :where(), [open] and :root", () => {
		for (const selector of [
			":checked",
			":disabled",
			":has(.x)",
			":not(.y)",
			":is(.a)",
			":where(.b)",
			"[open]",
			":root",
			"input:checked:disabled",
		]) {
			expect(cleanSelector(selector)).toBe(selector);
		}
	});

	it("makes a compound that is left empty *", () => {
		expect(cleanSelector("::placeholder")).toBe("*");
		expect(cleanSelector(".a > ::before")).toBe(".a > *");
		expect(cleanSelector("*,:before,:after,::backdrop")).toBe("*,*,*,*");
	});

	it("removes from the middle of a compound", () => {
		expect(cleanSelector(".a:hover.b")).toBe(".a.b");
	});

	it("does not split a comma inside a function's argument, and takes out what is inside it", () => {
		expect(cleanSelector(":is(.a,:hover)")).toBe(":is(.a,)");
	});

	it("cleans each part of a selector list on its own", () => {
		expect(cleanSelector(".a:hover, .b::before, .c")).toBe(".a, .b, .c");
		expect(cleanSelector(".a, ::before")).toBe(".a, *");
	});

	it("gives the same results when its source is run on its own, as screenshots.mjs does in the page", () => {
		const page = new Function(`return (${cleanSelector.toString()})`)();
		for (const selector of [
			".hover\\:underline:hover",
			"*,:before,:after,::backdrop",
			".a > ::before",
			'[data-x=":hover"]',
			":is(.a,:hover)",
			".a:focus-visible, .b::part(x)",
		]) {
			expect(page(selector)).toBe(cleanSelector(selector));
		}
	});
});
