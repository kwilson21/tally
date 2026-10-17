/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { MerchantRuleTick } from "../src/views/merchant-rule-tick";

describe("MerchantRuleTick (#353)", () => {
	it("is a real checkbox named always, in a 44px label, with the round mark", async () => {
		const html = await (
			<MerchantRuleTick merchant="Local Bakery" checked={false} />
		).toString();
		expect(html).toMatch(
			/<label[^>]*class="[^"]*\bmin-h-11\b[^"]*"[^>]*>[\s\S]*<\/label>/,
		);
		expect(html).toMatch(
			/<input class="peer sr-only" type="checkbox" name="always" value="1"( checked)? aria-labelledby="merchant-rule-title" aria-describedby="merchant-rule-hint"/,
		);
		expect(html).toContain("selection-mark");
		expect(html).toContain("rounded-full");
	});

	it("names the checkbox by its title alone, so the hint is only its description (not read twice)", async () => {
		const html = await (
			<MerchantRuleTick merchant="Local Bakery" checked={false} />
		).toString();
		expect(html).toContain(
			'aria-labelledby="merchant-rule-title" aria-describedby="merchant-rule-hint"',
		);
		expect(html).toContain(
			'<span id="merchant-rule-title">Use this category for Local Bakery from now on</span>',
		);
		expect(html).toContain(
			'<span id="merchant-rule-hint" class="text-sm text-muted">Leave it unticked to change just this one.</span>',
		);
	});

	it("is unticked by default, says Use this category for the store from now on, and hints it's optional", async () => {
		const html = await (
			<MerchantRuleTick merchant="Local Bakery" checked={false} />
		).toString();
		expect(html).not.toMatch(/name="always" value="1" checked/);
		expect(html).toContain("Use this category for Local Bakery from now on");
		expect(html).toContain("Leave it unticked to change just this one.");
	});

	it("opens ticked when a rule matches, and its hint says what unticking does", async () => {
		const html = await (
			<MerchantRuleTick
				merchant="Local Bakery"
				checked
				ruleCategory="Groceries"
			/>
		).toString();
		expect(html).toMatch(/name="always" value="1" checked/);
		expect(html).toContain(
			"Local Bakery is always Groceries. Untick it and save to remove the rule.",
		);
		expect(html).not.toContain("Leave it unticked");
	});

	it("a tick a person makes with no rule yet keeps the optional hint", async () => {
		const html = await (
			<MerchantRuleTick merchant="Local Bakery" checked />
		).toString();
		expect(html).toMatch(/name="always" value="1" checked/);
		expect(html).toContain("Leave it unticked to change just this one.");
	});

	it("a matching rule drawn unticked on a redraw still says that saving removes it", async () => {
		const html = await (
			<MerchantRuleTick
				merchant="Local Bakery"
				checked={false}
				ruleCategory="Groceries"
			/>
		).toString();
		expect(html).not.toMatch(/name="always" value="1" checked/);
		expect(html).toContain(
			"Local Bakery is always Groceries. Untick it and save to remove the rule.",
		);
		expect(html).not.toContain("Leave it unticked");
	});

	it("its check reads only its own checkbox (a named group), so a checked radio in a folded row above it can't show it (#701)", async () => {
		const html = await (
			<MerchantRuleTick merchant="Local Bakery" checked={false} />
		).toString();
		expect(html).toMatch(/<label class="group\/rule /);
		expect(html).toContain(
			'<span class="hidden group-has-[:checked]/rule:flex">',
		);
		expect(html).not.toContain("group-has-[:checked]:");
		expect(html).not.toMatch(/<label class="group /);
	});
});
