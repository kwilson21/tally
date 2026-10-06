/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { Switch } from "../src/views/switch";

const html = (props: Partial<Parameters<typeof Switch>[0]> = {}) =>
	String(
		Switch({
			id: "ai-income",
			name: "income",
			label: "Income",
			hint: "Spots paychecks and other money coming in.",
			...props,
		}),
	);

// P41 B (decision 73): a real checkbox drawn as a switch, with On or Off in words beside it.
describe("Switch", () => {
	it("is a real checkbox, so it posts with no script: on sends its value, off sends nothing", () => {
		const on = html({ checked: true });
		expect(on).toMatch(/<input[^>]*type="checkbox"/);
		expect(on).toMatch(/<input[^>]*name="income"/);
		expect(on).toMatch(/<input[^>]*value="on"/);
		expect(on).toMatch(/<input[^>]*checked/);
		expect(html({ checked: false })).not.toMatch(/<input[^>]*checked/);
	});

	it("is a switch to a screen reader, named by its label and described by its muted line", () => {
		const out = html();
		expect(out).toMatch(/<input[^>]*role="switch"/);
		expect(out).toMatch(/<input[^>]*aria-labelledby="ai-income-label"/);
		expect(out).toMatch(/<input[^>]*aria-describedby="ai-income-hint"/);
		expect(out).toMatch(/id="ai-income-label"[^>]*>Income</);
		expect(out).toMatch(
			/id="ai-income-hint"[^>]*>Spots paychecks and other money coming in\.</,
		);
	});

	it("leaves out the description when there is no muted line", () => {
		const out = html({ hint: undefined });
		expect(out).not.toContain("aria-describedby");
		expect(out).not.toContain("ai-income-hint");
	});

	it("says On or Off in words beside the switch, hidden from a screen reader that already hears the state", () => {
		const out = html();
		expect(out).toMatch(
			/<span aria-hidden="true"[^>]*>\s*<span class="hidden group-has-\[:checked\]:inline">On<\/span>\s*<span class="group-has-\[:checked\]:hidden">Off<\/span>\s*<\/span>/,
		);
	});

	it("draws the track and knob from the checkbox's state alone, with no script or style attribute", () => {
		const out = html();
		expect(out).toContain("group-has-[:checked]:bg-ink");
		expect(out).toContain("group-has-[:checked]:translate-x-[1.375rem]");
		expect(out).not.toMatch(/\sstyle=|\sonclick=|<script/);
	});

	it("makes the whole row a 44px target with a focus-visible ring", () => {
		const label = html().match(/<label[^>]*class="([^"]*)"/)?.[1] ?? "";
		expect(label).toContain("min-h-11");
		expect(label).toContain("cursor-pointer");
		expect(label).toContain("has-[:focus-visible]:outline-2");
		expect(label).toContain("has-[:focus-visible]:outline-accent");
	});

	it("keeps the real input visually hidden but reachable", () => {
		expect(html().match(/<input[^>]*class="([^"]*)"/)?.[1]).toBe("sr-only");
	});

	it("slides the knob with the switch classes, whose 150 ms and reduced-motion version live in app.css (test/motion.test.tsx)", () => {
		const out = html();
		expect(out).toMatch(/class="switch-track /);
		expect(out).toMatch(/class="switch-knob /);
		expect(out).not.toMatch(/duration-|transition/);
	});
});
