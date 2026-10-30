/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { Chip } from "../src/views/chip";

describe("Chip", () => {
	it("fades and shows a not-allowed cursor when its input is disabled, as Button does", () => {
		// A refund linked to a purchase disables the Category fieldset: its chips must not look clickable.
		const label =
			String(
				Chip({ type: "radio", name: "category", value: "1", children: "Gas" }),
			).match(/<label [^>]*>/)?.[0] ?? "";
		expect(label).toContain("has-[:disabled]:cursor-not-allowed");
		expect(label).toContain("has-[:disabled]:opacity-40");
	});

	it("wraps its label between words and ends one too-long word in an ellipsis inside the pill", () => {
		const html = String(
			Chip({
				type: "radio",
				name: "category",
				value: "1",
				children: "Householdandgardensuppliesandmore",
			}),
		);
		expect(html).toContain(
			'<span class="min-w-0 overflow-hidden text-ellipsis">Householdandgardensuppliesandmore</span>',
		);
		expect(html).not.toContain("wrap-anywhere");
	});
});
