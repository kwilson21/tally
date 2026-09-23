import { describe, expect, it } from "vitest";
import { LedgerIllustration } from "../src/views/illustration";

describe("LedgerIllustration", () => {
	it("is decorative", async () => {
		const html = await LedgerIllustration().toString();
		expect(html).toContain('aria-hidden="true"');
	});

	it("uses the icon stroke width (DESIGN.md: illustrations follow the icon stroke rules)", async () => {
		const html = await LedgerIllustration().toString();
		expect(html.match(/stroke-width="([^"]+)"/g)).toEqual([
			'stroke-width="1.75"',
		]);
	});

	it("fills the pencil with paper so the notebook behind it doesn't show through", async () => {
		const html = await LedgerIllustration().toString();
		const pencil = html.slice(html.indexOf('class="stroke-accent'));
		expect(pencil).toMatch(/^class="stroke-accent fill-paper"/);
	});
});
