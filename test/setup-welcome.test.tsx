/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { SetupScreen } from "../src/views/setup-screen";

// A setup screen's frame (P142 A, decision 148): its body, then its foot. On a phone the foot is pinned to the screen's foot.
const html = (node: unknown) => String(node).replaceAll("&#39;", "'");

describe("SetupScreen", () => {
	it("draws its body, and no foot when none is given", () => {
		const markup = html(
			<SetupScreen>
				<p>The body</p>
			</SetupScreen>,
		);
		expect(markup).toContain('<div id="setup-screen">');
		expect(markup).toContain("<p>The body</p>");
		expect(markup).not.toContain("sticky");
		expect(markup).not.toContain("lg:static");
	});

	it("draws its foot after the body, pinned to the screen's foot on a phone and under the body from lg", () => {
		const markup = html(
			<SetupScreen foot={<button type="button">Link your bank</button>}>
				<p>The body</p>
			</SetupScreen>,
		);
		expect(markup.indexOf("The body")).toBeLessThan(
			markup.indexOf("Link your bank"),
		);
		expect(markup).toMatch(
			/<div class="[^"]*\bsticky bottom-0\b[^"]*\blg:static\b[^"]*">/,
		);
		expect(markup).toContain("pb-[calc(1.5rem+var(--safe-area-bottom))]");
		expect(markup).toContain("<button type=\"button\">Link your bank</button>");
	});
});
