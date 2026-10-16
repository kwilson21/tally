import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { billTotalsForRows } from "../src/bills/totals";
import { summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { plansSetAsideCents } from "../src/db/planned-expenses";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";
import { loadBillRows } from "../src/routes/bills";

const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const MONTH = TODAY.slice(0, 7);

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
});

describe("the demo's planned expenses", () => {
	it("shows Car registration's Band on Bills, with the Planned group and Lawn service under it", async () => {
		const html = await (await exports.default.fetch(`${BASE}/bills`)).text();
		expect(html).toContain("Car registration wasn&#39;t paid");
		expect(html).toContain("Planned");
		expect(html).toContain("Lawn service");
	});

	it("sets both aside in Safe to spend: this month's Lawn service and last month's unpaid Car registration", async () => {
		// Lawn service ($90, this month) and Car registration ($180, last month, unpaid): $270 set aside.
		expect(await plansSetAsideCents(env.DB, MONTH)).toBe(27000);

		const data = await loadMonth(env.DB, MONTH);
		const billData = await loadBillRows(env.DB, TODAY);
		// The same bills total Home's Safe to spend subtracts (home.test.ts), so only the plans differ here.
		const dueBills = billTotalsForRows(MONTH, billData.rows).setAsideCents;
		const withoutPlans = summarizeMonth({
			month: MONTH,
			...data,
			unpaidDueBillsCents: dueBills,
		}).safeToSpendCents;
		const withPlans = summarizeMonth({
			month: MONTH,
			...data,
			unpaidDueBillsCents: dueBills,
			unpaidPlansCents: 27000,
		}).safeToSpendCents;
		expect(withoutPlans - withPlans).toBe(27000);

		const html = await (await exports.default.fetch(`${BASE}/`)).text();
		expect(html).toContain(formatCents(withPlans, { wholeDollars: true }));
	});
});
