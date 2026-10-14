/** @jsxImportSource hono/jsx */
import { renderToString } from "hono/jsx/dom/server";
import { describe, expect, it } from "vitest";
import {
	SheetCancel,
	SheetFooter,
	SheetPrimary,
} from "../src/views/sheet-footer";

describe("SheetFooter", () => {
	it("sets Cancel and the primary side by side, each full width and 44px tall", () => {
		const html = renderToString(
			<SheetFooter>
				<SheetCancel href="/bills" />
				<SheetPrimary form="bill-form">Save</SheetPrimary>
			</SheetFooter>,
		);
		expect(html.startsWith('<div class="grid grid-cols-2 gap-3">')).toBe(true);
		const cancel = html.match(/<a [^>]*>/)?.[0] ?? "";
		const primary = html.match(/<button [^>]*>/)?.[0] ?? "";
		for (const tag of [cancel, primary]) {
			expect(tag).toContain("min-h-11");
			expect(tag).toContain("w-full");
		}
	});

	it("makes Cancel a link back to the list, with the sheet's close attributes", () => {
		const html = renderToString(
			<SheetFooter>
				<SheetCancel
					href="/bills"
					attrs={{ "hx-get": "/bills", "hx-target": "#page" }}
				/>
				<SheetPrimary form="bill-form">Save</SheetPrimary>
			</SheetFooter>,
		);
		expect(html).toContain('<a href="/bills"');
		expect(html).toContain('hx-get="/bills"');
		expect(html).toContain('hx-target="#page"');
		expect(html).toContain(">Cancel</a>");
	});

	it("makes the primary a submit button that belongs to the form by its id, with the busy label", () => {
		const html = renderToString(
			<SheetFooter>
				<SheetCancel href="/bills" />
				<SheetPrimary id="bill-save" form="bill-form" busyLabel="Saving…">
					Save
				</SheetPrimary>
			</SheetFooter>,
		);
		const primary = html.match(/<button [^>]*>/)?.[0] ?? "";
		expect(primary).toContain('type="submit"');
		expect(primary).toContain('form="bill-form"');
		// The form's hx-indicator names it by this id, so its busy label shows while the form posts.
		expect(primary).toContain('id="bill-save"');
		expect(html).toContain("Saving…");
		expect(html).toContain(">Save<");
	});
});
