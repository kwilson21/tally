import { describe, expect, it } from "vitest";
import {
	CASH_MERCHANT_MAX,
	CATEGORY_NAME_MAX,
	DISPLAY_NAME_MAX,
	FEEDBACK_MESSAGE_MAX,
	NOTE_MAX,
	PERSON_NAME_MAX,
	PLAN_NAME_MAX,
} from "../src/limits";
import { parseCategory } from "../src/settings/category-form";
import { parseCash } from "../src/transactions/cash";

// How long a typed text may be is written once, in src/limits.ts, and the form's maxlength and the server's check both read
// it (audit finding 9). Two copies of a number drift: a form that lets 60 characters through to a server that refuses 40.

const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;
const APP = Object.entries(SOURCES).filter(
	([file]) => !file.includes("/design-system/") && !file.endsWith("/limits.ts"),
);
const LIMITS = "40|80|120|500|2000";

/** The lines of code in a file: not a whole-line comment. */
const codeLines = (text: string) =>
	text.split("\n").filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line));

describe("the text limits", () => {
	it("are whole numbers a form can offer", () => {
		for (const limit of [
			CATEGORY_NAME_MAX,
			PERSON_NAME_MAX,
			DISPLAY_NAME_MAX,
			PLAN_NAME_MAX,
			NOTE_MAX,
			CASH_MERCHANT_MAX,
			FEEDBACK_MESSAGE_MAX,
		])
			expect(Number.isInteger(limit) && limit > 0).toBe(true);
	});

	it("are written as numbers only in src/limits.ts: no maxlength, length check or message spells one out", () => {
		const offenders: string[] = [];
		for (const [file, text] of APP)
			for (const line of codeLines(text)) {
				if (
					new RegExp(`maxlength=\\{\\s*(?:${LIMITS})\\s*\\}`).test(line) ||
					new RegExp(`\\.length\\s*(?:>|>=|<|<=)\\s*(?:${LIMITS})\\b`).test(
						line,
					) ||
					new RegExp(`["'\`][^"'\`]*\\b(?:${LIMITS}|2,000) characters`).test(
						line,
					)
				)
					offenders.push(
						`${file.replace("../", "")}: ${line.trim().slice(0, 90)}`,
					);
			}
		expect(offenders).toEqual([]);
	});

	it("are each defined in one place", () => {
		const names = [
			"CATEGORY_NAME_MAX",
			"PERSON_NAME_MAX",
			"DISPLAY_NAME_MAX",
			"PLAN_NAME_MAX",
			"NOTE_MAX",
			"CASH_MERCHANT_MAX",
			"FEEDBACK_MESSAGE_MAX",
			"MAX_OWN_NAME",
		];
		const definers = APP.filter(([, text]) =>
			new RegExp(`\\bconst\\s+(?:${names.join("|")})\\s*=`).test(text),
		).map(([file]) => file);
		expect(definers).toEqual([]);
	});
});

describe("the server checks use the limits", () => {
	const category = (name: string) => {
		const form = new FormData();
		form.set("name", name);
		return parseCategory(form, [], null);
	};

	it("takes a category name of exactly the limit and refuses one a character longer", () => {
		expect(category("a".repeat(CATEGORY_NAME_MAX)).ok).toBe(true);
		const result = category("a".repeat(CATEGORY_NAME_MAX + 1));
		expect(result.ok).toBe(false);
		expect(!result.ok && result.errors.name).toBe(
			`Keep the name to ${CATEGORY_NAME_MAX} characters.`,
		);
	});

	it("takes a cash merchant and note of exactly their limits and refuses a character more", () => {
		const cash = (merchant: string, note: string) =>
			parseCash(
				{ date: "2026-09-20", amount: "5.00", merchant, category: "1", note },
				"2026-09-22",
				[1],
			);
		const ok = cash("m".repeat(CASH_MERCHANT_MAX), "n".repeat(NOTE_MAX));
		expect(JSON.stringify(ok)).not.toContain("characters or fewer");
		const long = JSON.stringify(
			cash("m".repeat(CASH_MERCHANT_MAX + 1), "n".repeat(NOTE_MAX + 1)),
		);
		expect(long).toContain(`Use ${CASH_MERCHANT_MAX} characters or fewer.`);
		expect(long).toContain(`Use ${NOTE_MAX} characters or fewer.`);
	});
});
