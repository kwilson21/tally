import { describe, expect, it } from "vitest";
import { merchantRuleChange } from "../src/transactions/edit";

describe("merchantRuleChange", () => {
	it.each([
		[
			"newly checked sets rule and recategorizes",
			false,
			true,
			1,
			3,
			"set",
			true,
		],
		["matching rule stays unchanged", true, true, 1, 1, "keep", false],
		[
			"different picked category stays transaction-only",
			true,
			true,
			1,
			3,
			"keep",
			false,
		],
		["explicitly unchecked clears", true, false, 1, 3, "clear", false],
		[
			"unchecked note save leaves rule alone",
			false,
			false,
			1,
			null,
			"keep",
			false,
		],
		[
			"unchecked differing transaction leaves rule alone",
			false,
			false,
			1,
			3,
			"keep",
			false,
		],
		[
			"paused checked rule with no category leaves rule alone",
			true,
			true,
			1,
			null,
			"keep",
			false,
		],
	] as const)(
		"%s",
		(_name, was, now, ruleWas, categoryId, action, recategorize) => {
			expect(merchantRuleChange(was, now, ruleWas, categoryId)).toEqual({
				action,
				recategorize,
			});
		},
	);
});
