import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadPriceOffers } from "../src/bills/price-change";
import { daysBefore } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { loadBillRows } from "../src/routes/bills";

// The demo moves with "today", so what its Bills page asks has to hold on every day of a month: exactly
// one "Price changed?" offer, Netflix's ($15.49, charged $17.99), and none because some other bill's
// merchant happens to have other charges nearby (Electric and Internet are unpaid on purpose).

const run = (from: string, days: number) =>
	Array.from({ length: days }, (_, i) => daysBefore(from, -i));

const DAYS = [
	...run("2026-10-01", 31),
	...run("2026-11-01", 30),
	// A short February, a leap one, and the turn of a year.
	...run("2027-02-01", 28),
	...run("2028-02-01", 29),
	...run("2026-12-24", 15),
];

describe("the demo's price-changed offer", () => {
	it("is Netflix's alone, on every day tried", {
		timeout: 180_000,
	}, async () => {
		const problems: string[] = [];
		for (const today of DAYS) {
			await resetDemo(env.DB, today);
			const { rows } = await loadBillRows(env.DB, today);
			const offers = await loadPriceOffers(env.DB, rows);
			const asked = rows
				.filter((row) => offers.has(row.id))
				.map((row) => row.name);
			const netflix = rows.find((row) => row.name === "Netflix");
			const offer = netflix && offers.get(netflix.id);
			if (asked.join() !== "Netflix") problems.push(`${today}: ${asked}`);
			else if (
				netflix?.amountCents !== 1549 ||
				offer?.amountCents !== 1799 ||
				netflix.status !== "overdue" ||
				offer.merchant !== "Netflix"
			)
				problems.push(`${today}: ${JSON.stringify([netflix, offer])}`);
			// The bills that make the demo's Safe to spend set money aside stay unpaid.
			const status = (name: string) =>
				rows.find((row) => row.name === name)?.status;
			if (status("Electric") !== "overdue" || status("Internet") !== "due")
				problems.push(
					`${today}: Electric ${status("Electric")}, Internet ${status("Internet")}`,
				);
		}
		expect(problems).toEqual([]);
	});
});
