import { describe, expect, it } from "vitest";
import {
	CASH_MERCHANT_MAX,
	CATEGORY_NAME_MAX,
	DISPLAY_NAME_MAX,
	FEEDBACK_MESSAGE_MAX,
	MERCHANT_KEY_MAX,
	NOTE_MAX,
	PERSON_NAME_MAX,
	PLAN_NAME_MAX,
} from "../src/limits";
import { parseCategory } from "../src/settings/category-form";
import { parseCash } from "../src/transactions/cash";
import { present } from "./helpers/present";

// How long a typed text may be is written once, in src/limits.ts, and the form's maxlength and the server's check both read
// it (audit finding 9). Two copies of a number drift: a form that lets 60 characters through to a server that refuses 40.

const SOURCES = import.meta.glob("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
});

const APP = Object.entries(SOURCES).filter(
	([file]) => !file.includes("/design-system/") && !file.endsWith("/limits.ts"),
);

// Every number the limits file holds, so a changed limit stays covered; the feedback message is also spelled "2,000".
const LIMITS = [
	...new Set([
		CATEGORY_NAME_MAX,
		PERSON_NAME_MAX,
		DISPLAY_NAME_MAX,
		PLAN_NAME_MAX,
		NOTE_MAX,
		CASH_MERCHANT_MAX,
		FEEDBACK_MESSAGE_MAX,
		MERCHANT_KEY_MAX,
	]),
].join("|");

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
			MERCHANT_KEY_MAX,
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

	it("are not kept in a named constant elsewhere: a limit-like constant set to one of these numbers is listed with its reason", () => {
		// Numbers that are a different rule from a typed text's length, so they stay where they are.
		const OTHER_RULES = [
			{
				file: "src/ai/suggest-name.ts",
				name: "MAX_LENGTH",
				why: "the longest name the model may suggest",
			},
			{
				file: "src/ai/suggest-name.ts",
				name: "MAX_NOTE_LENGTH",
				why: "the longest note the model may suggest",
			},
			{
				file: "src/ai/suggest-name.ts",
				name: "MAX_BANK_TEXT",
				why: "how much bank text may be sent to the model",
			},
			{
				file: "src/routes/push.ts",
				name: "MAX_ENDPOINT_LENGTH",
				why: "a push subscription's endpoint URL, not typed text",
			},
		];

		const pattern = new RegExp(
			`\\bconst\\s+((?=[A-Z0-9_]*(?:MAX|LIMIT|LENGTH|LEN|CHARS))[A-Z][A-Z0-9_]*)\\s*=\\s*(?:${LIMITS})\\s*;`,
			"g",
		);

		const found: { file: string; name: string }[] = [];

		for (const [file, text] of APP)
			for (const match of codeLines(text).join("\n").matchAll(pattern))
				found.push({ file: file.replace("../", ""), name: present(match[1]) });

		const unlisted = found.filter(
			(f) => !OTHER_RULES.some((o) => o.file === f.file && o.name === f.name),
		);

		expect(unlisted.map((f) => `${f.file}: ${f.name}`)).toEqual([]);

		// A listed constant that no longer exists is removed from the list.
		const stale = OTHER_RULES.filter(
			(o) => !found.some((f) => f.file === o.file && f.name === o.name),
		);

		expect(stale.map((o) => `${o.file}: ${o.name}`)).toEqual([]);
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
			"MERCHANT_KEY_MAX",
			"MAX_OWN_NAME",
			"MAX_STORE_KEY",
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
