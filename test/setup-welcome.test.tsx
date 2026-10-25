/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { SetupScreen } from "../src/views/setup-screen";
import {
	SetupWelcome,
	WELCOME_HEADING,
	WELCOME_STEPS,
} from "../src/views/setup-welcome";

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
		expect(markup).toContain('<button type="button">Link your bank</button>');
	});
});

describe("SetupWelcome", () => {
	const welcome = (props: Parameters<typeof SetupWelcome>[0] = {}) =>
		html(SetupWelcome(props));
	const LINK_BUTTON = <button type="button">Link your bank</button>;
	const LINK = '<button type="button">Link your bank</button>';
	const LINE = "Tally can only read your bank. It can't move money.";

	it("says every word of the welcome, as the picked drawing does", () => {
		const markup = welcome({ linkBank: LINK_BUTTON });
		expect(markup).toContain("Welcome to Tally.");
		expect(markup).toContain(
			"Tally reads your bank, sorts your spending and shows what's safe to spend this month.",
		);
		expect(markup).toContain("Four steps, about four minutes of your time.");
		expect(markup).toContain(LINE);
		expect(WELCOME_HEADING).toBe("Welcome to Tally.");
		expect(
			WELCOME_STEPS.map((step) => [step.name, step.benefit, step.note]),
		).toEqual([
			[
				"Link your bank",
				"Tally reads your last 90 days, so you don't start from zero.",
				"About a minute",
			],
			["Your pay", "So Tally knows what comes in.", "One question"],
			["Your bills", "So they're set aside before you spend.", "One question"],
			["Your budgets", "Suggested from what you really spend.", "One tap"],
		]);
		for (const step of WELCOME_STEPS) {
			expect(markup).toContain(step.name);
			expect(markup).toContain(step.benefit);
			expect(markup).toContain(step.note);
		}
	});

	it("draws the four steps as the items of one ordered list, in order", () => {
		const markup = welcome({ linkBank: LINK_BUTTON });
		const list = markup.split("<ol")[1]?.split("</ol>")[0] ?? "";
		expect(markup.split("<ol").length - 1).toBe(1);
		expect(list.split("<li").length - 1).toBe(4);
		const order = WELCOME_STEPS.map((step) => list.indexOf(step.name));
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(order.every((at) => at > 0)).toBe(true);
	});

	it("draws the given Link your bank in the foot, above the line that Tally can only read the bank", () => {
		const markup = welcome({ linkBank: LINK_BUTTON });
		expect(markup).toContain(LINK);
		expect(markup.indexOf(LINK)).toBeLessThan(markup.indexOf(LINE));
		expect(markup.indexOf("Four steps")).toBeLessThan(markup.indexOf(LINK));
	});

	it("draws the line and no button with no linkBank (Plaid off)", () => {
		const markup = welcome({});
		expect(markup).toContain(LINE);
		expect(markup).not.toContain("<button");
	});

	it("puts autofocus and tabindex=-1 on the heading only when it takes focus", () => {
		const focused = welcome({ focusHeading: true });
		expect(focused).toMatch(
			/<h1[^>]*id="setup-title"[^>]*tabindex="-1"[^>]*autofocus/,
		);
		const plain = welcome({});
		expect(plain).toContain("<h1");
		expect(plain).not.toContain("autofocus");
		expect(plain).not.toContain('tabindex="-1"');
	});
});
