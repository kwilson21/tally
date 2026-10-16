import { describe, expect, it } from "vitest";
import { TYPE_ROLES } from "../src/design-system/tokens";
import { netWorthView } from "../src/net-worth";
import { AccountsTop } from "../src/views/accounts-top";
import {
	headlineAmountClass,
	homeDrawingClass,
} from "../src/views/headline-amount";
import { HomeTop } from "../src/views/home-top";
import { MonthEnd } from "../src/views/month-end";
import { TrendsTop } from "../src/views/trends";

const quoteForRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&");

/** The class attribute of the element whose text is exactly `text`, or undefined. */
const classOf = (html: string, text: string) =>
	html.match(new RegExp(`class="([^"]*)">${quoteForRegExp(text)}<`))?.[1];

const RULE = "max-sm:text-5xl";

// Decision 110: every headline amount of 9 or more displayed characters is one size smaller on a
// phone narrower than 640px. Eight characters or fewer keep the base size, and so do desktop sizes.
describe("headlineAmountClass", () => {
	it("keeps the base size for 8 characters or fewer", () => {
		expect(headlineAmountClass("$999,999")).toBe("");
		expect(headlineAmountClass("−$99,999")).toBe("");
		expect(headlineAmountClass("$0")).toBe("");
	});

	it("steps 9 or more characters down on phones, negative and positive alike", () => {
		expect(headlineAmountClass("−$999,999")).toBe(RULE);
		expect(headlineAmountClass("-$999,999")).toBe(RULE);
		expect(headlineAmountClass("$1,000,000")).toBe(RULE);
		expect(headlineAmountClass("-$1,000,000")).toBe(RULE);
	});

	it("is the class the Headline amount type role lists for a 9-character amount", () => {
		const role = TYPE_ROLES.find(
			(r) => r.role === "Headline amount, 9 or more characters",
		);
		expect(role?.classes.split(" ")).toContain(RULE);
		expect(role?.classes.split(" ")).toContain("text-6xl");
		expect(headlineAmountClass(role?.sample ?? "")).toBe(RULE);
		expect(
			TYPE_ROLES.find((r) => r.role === "Headline amount")?.classes,
		).not.toContain(RULE);
	});
});

// Issue #500 (P127 A, decision 116): Home's notebook drawing follows the amount's length. Up to 7
// characters it shows from 390px; 8 or more it shows from 640px, because the widest 8-character
// amount never fits beside the drawing with 8px to spare at any phone width up to 430px.
describe("homeDrawingClass", () => {
	it("shows the drawing from 390px for 7 characters or fewer", () => {
		expect(homeDrawingClass("$283")).toBe("min-[390px]:block");
		expect(homeDrawingClass("−$9,999")).toBe("min-[390px]:block");
	});

	it("waits for 640px from 8 characters, the length where the amount stops fitting beside it", () => {
		expect(homeDrawingClass("−$19,999")).toBe("sm:block");
		expect(homeDrawingClass("$199,999")).toBe("sm:block");
	});

	it("leaves the drawing out below 640px for 9 or more characters", () => {
		expect(homeDrawingClass("−$999,999")).toBe("sm:block");
		expect(homeDrawingClass("$1,000,000")).toBe("sm:block");
		expect(homeDrawingClass("−$1,000,000")).toBe("sm:block");
	});
});

describe("HomeTop Safe to spend", () => {
	const top = async (safeToSpendCents: number) =>
		String(
			await HomeTop({
				month: "September",
				safeToSpendCents,
				status: "On track.",
			}),
		);

	// Home's amount sits in a nowrap run (#500), so the headline's class is the one before that run.
	const headlineClassOf = (html: string, text: string) =>
		html.match(
			new RegExp(
				`class="([^"]*)"><span class="whitespace-nowrap">${quoteForRegExp(text)}<`,
			),
		)?.[1];

	it("steps a 9-character amount down and keeps the base size for 8", async () => {
		expect(headlineClassOf(await top(100000000), "$1,000,000")).toContain(RULE);
		expect(headlineClassOf(await top(-99999900), "−$999,999")).toContain(RULE);
		expect(headlineClassOf(await top(99999900), "$999,999")).not.toContain(
			"max-sm",
		);
	});
});

describe("MonthEnd result", () => {
	const end = async (amountCents: number) =>
		String(
			await MonthEnd({
				chartId: "result",
				monthName: "September",
				amountCents,
				unbudgeted: [],
				rows: [
					{
						id: 1,
						name: "Groceries",
						budgetCents: 200000000,
						spentCents: 0,
						leftCents: 200000000,
						over: false,
					},
				],
			}),
		);

	it("steps a seven-figure result down and keeps the finished-month size at every width", async () => {
		const amount = classOf(await end(100000000), "$1,000,000");
		expect(amount).toContain(RULE);
		expect(amount).toContain("text-6xl");
		expect(amount).not.toContain("lg:text-7xl");
		expect(amount).toContain("whitespace-nowrap");
	});

	it("steps a seven-figure over result down too, shown without its minus sign", async () => {
		expect(classOf(await end(-100000000), "$1,000,000")).toContain(RULE);
	});

	it("keeps the base size for a result that shows 8 characters", async () => {
		expect(classOf(await end(99999900), "$999,999")).not.toContain("max-sm");
	});
});

describe("AccountsTop Net worth", () => {
	const noDays = netWorthView([], "2026-10-13");

	it("steps a seven-figure net worth down, positive and negative", async () => {
		const up = String(
			await AccountsTop({ netWorthCents: 100000000, history: noDays }),
		);
		expect(classOf(up, "$1,000,000")).toContain(RULE);
		const down = String(
			await AccountsTop({ netWorthCents: -100000000, history: noDays }),
		);
		expect(classOf(down, "-$1,000,000")).toContain(RULE);
	});

	it("keeps the base size for a net worth of 8 characters", async () => {
		const html = String(
			await AccountsTop({ netWorthCents: 99999900, history: noDays }),
		);
		expect(classOf(html, "$999,999")).not.toContain("max-sm");
	});
});

describe("TrendsTop Spent so far", () => {
	it("steps a seven-figure spent amount down and keeps the base size for 8", async () => {
		const big = String(
			await TrendsTop({ month: "October", spent: "$1,000,000" }),
		);
		expect(classOf(big, "$1,000,000")).toContain(RULE);
		const small = String(
			await TrendsTop({ month: "October", spent: "$999,999" }),
		);
		expect(classOf(small, "$999,999")).not.toContain("max-sm");
	});
});
