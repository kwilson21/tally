import { describe, expect, it } from "vitest";
import { LedgerIllustration } from "../src/views/illustration";

describe("LedgerIllustration", () => {
	it("is decorative", async () => {
		const html = await LedgerIllustration().toString();
		expect(html).toContain('aria-hidden="true"');
	});

	it("fills the pencil with paper so the notebook behind it doesn't show through", async () => {
		const html = await LedgerIllustration().toString();
		const pencil = html.slice(html.indexOf('class="stroke-accent'));
		expect(pencil).toMatch(/^class="stroke-accent fill-paper"/);
	});
});
