import { describe, expect, it } from "vitest";
import {
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

	it("leaves a value that is not a v4 UUID as it is", () => {
		const v1 = "00000000-0000-1000-8000-000000000000";
		expect(normalizeDom(`<i data-id="${v1}"></i>`)).toContain(v1);
	});
});

describe("fingerprintOf", () => {
	const dom = "<main><h1>Home</h1></main>";
	const APP_CSS = { path: "/assets/app.css", sha256: "aa" };
	const HTMX = { path: "/vendor/htmx.min.js", sha256: "bb" };
	const assets = [APP_CSS, HTMX];

	it("is the same whatever order the assets were loaded in", async () => {
		expect(await fingerprintOf({ dom, assets })).toBe(
			await fingerprintOf({ dom, assets: [...assets].reverse() }),
		);
	});

	it("is the same for two loads whose only difference is a v4 UUID", async () => {
		const load = (key: string) =>
			`<main><input name="entry_key" value="${key}"></main>`;
		expect(await fingerprintOf({ dom: load(FIRST), assets })).toBe(
			await fingerprintOf({ dom: load(SECOND), assets }),
		);
	});

	it("changes when an asset's content changes", async () => {
		const changed = [APP_CSS, { ...HTMX, sha256: "bc" }];
		expect(await fingerprintOf({ dom, assets: changed })).not.toBe(
			await fingerprintOf({ dom, assets }),
		);
	});

	it("changes when an asset's path changes", async () => {
		const moved = [{ ...APP_CSS, path: "/assets/app.v2.css" }, HTMX];
		expect(await fingerprintOf({ dom, assets: moved })).not.toBe(
			await fingerprintOf({ dom, assets }),
		);
	});

	it("changes when the DOM changes", async () => {
		expect(
			await fingerprintOf({ dom: "<main><h1>Gas</h1></main>", assets }),
		).not.toBe(await fingerprintOf({ dom, assets }));
	});

	it("keeps a path and a hash from running together", async () => {
		// Joined with no separator, both read "/abc": only the field boundaries tell them apart.
		expect(
			await fingerprintOf({
				dom,
				assets: [{ path: "/a", sha256: "bc" }],
			}),
		).not.toBe(
			await fingerprintOf({
				dom,
				assets: [{ path: "/ab", sha256: "c" }],
			}),
		);
	});

	it("is a 64-character lowercase hex SHA-256", async () => {
		expect(await fingerprintOf({ dom, assets })).toMatch(/^[0-9a-f]{64}$/);
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
