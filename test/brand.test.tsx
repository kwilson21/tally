/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { Wordmark } from "../src/views/brand";

describe("Wordmark", () => {
	it("is a link Home that is at least 44px tall, and only as wide as the mark and word", () => {
		const html = String(Wordmark());
		const link = html.match(/<a [^>]*>/)?.[0] ?? "";
		expect(link).toContain('href="/"');
		expect(link).toContain('aria-label="Tally home"');
		// 44px target (CLAUDE.md): the 36px serif line is centred in a min-h-11 box.
		expect(link).toMatch(/class="[^"]*\bmin-h-11\b/);
		// Not a strip across the whole phone.
		expect(link).toMatch(/class="[^"]*\bw-fit\b/);
	});
});
