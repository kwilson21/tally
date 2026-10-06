// The Account and Show filters (#210, spec §8.4): which rows each keeps, against the demo household.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMonth } from "../src/budget";
import { accountChoices } from "../src/db/accounts";
import { loadMonth } from "../src/db/month";
import { listTransactions } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { parseFilters } from "../src/transactions/filters";

const TODAY = "2026-09-22";
const list = (qs: string) =>
	listTransactions(env.DB, parseFilters(new URLSearchParams(qs), "2026-09"));

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
});

const ids = async (qs: string) =>
	(await listAll(qs)).map((row) => row.id).sort((a, b) => a - b);

/** Every row across every page, for sums that must match Home's. */
async function listAll(qs: string) {
	const first = await list(qs);
	const rows = [...first.rows];
	for (let page = 2; page <= first.pages; page++) {
		rows.push(...(await list(`${qs}&page=${page}`)).rows);
	}
	return rows;
}

const CHECKING = 1;
const CARD = 3;
const CASH = 4;

describe("listTransactions by account", () => {
	it("lists only that account's rows, and the accounts add up to the whole list", async () => {
		const month = "2026-09";
		const whole = (await listAll(`month=${month}`)).length;
		let sum = 0;
		for (const account of [1, 2, 3, 4]) {
			const rows = await listAll(`month=${month}&account=${account}`);
			sum += rows.length;
			const { results } = await env.DB.prepare(
				`SELECT id FROM transactions WHERE account_id = ?`,
			)
				.bind(account)
				.all<{ id: number }>();
			const theirs = new Set(results.map((r) => r.id));
			expect(
				rows.every((r) => theirs.has(r.id)),
				`account ${account}`,
			).toBe(true);
		}
		expect(sum).toBe(whole);
	});

	it("lists the Cash account's entries", async () => {
		const rows = await listAll(`month=all&account=${CASH}`);
		expect(rows.map((r) => r.displayName)).toEqual(["Farmers market"]);
	});

	it("keeps a split's parts with their account", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,is_split) VALUES(850,?,'2026-09-03',4000,'SPLIT PARENT',1)",
			).bind(CARD),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,parent_id,category_id) VALUES(851,?,'2026-09-03',1500,'SPLIT PARENT',850,1),(852,?,'2026-09-03',2500,'SPLIT PARENT',850,4)",
			).bind(CARD, CARD),
		]);
		expect(await ids(`month=2026-09&account=${CARD}`)).toEqual(
			expect.arrayContaining([850, 851, 852]),
		);
		const checking = await ids(`month=2026-09&account=${CHECKING}`);
		expect(checking).not.toContain(851);
		expect(checking).not.toContain(852);
	});

	it("combines with the other filters", async () => {
		const groceriesInCash = await listAll(
			`month=all&account=${CASH}&category=1`,
		);
		expect(groceriesInCash.map((r) => r.displayName)).toEqual([
			"Farmers market",
		]);
		expect(await ids(`month=all&account=${CASH}&category=2`)).toEqual([]);
	});

	it("is empty for an account that isn't there", async () => {
		expect(await ids("month=all&account=999")).toEqual([]);
	});
});

describe("listTransactions by type", () => {
	// A September of every kind of money in, and two purchases, on top of the demo's own rows.
	beforeEach(async () => {
		const row = (values: string) =>
			env.DB.prepare(
				`INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,flag_income,flag_transfer,excluded,is_split,parent_id,refund_of_id,credit_reviewed) VALUES ${values}`,
			);
		await env.DB.batch([
			// A paycheck flagged income.
			row(
				`(860,${CHECKING},'2026-09-04',-300000,'EXTRA PAYCHECK',NULL,1,0,0,0,NULL,NULL,1)`,
			),
			// A purchase, and a refund of it that counts with it.
			row(
				`(861,${CARD},'2026-09-05',5000,'GADGET STORE',1,0,0,0,0,NULL,NULL,NULL)`,
			),
			row(
				`(862,${CARD},'2026-09-06',-2000,'GADGET STORE REFUND',1,0,0,0,0,NULL,861,1)`,
			),
			// A refund nobody linked, and a credit nobody has identified.
			row(
				`(863,${CARD},'2026-09-07',-1500,'UNLINKED REFUND',1,0,0,0,0,NULL,NULL,1)`,
			),
			row(
				`(864,${CHECKING},'2026-09-08',-900,'MYSTERY CREDIT',NULL,0,0,0,0,NULL,NULL,NULL)`,
			),
			// A transfer in, left out of the budget; and one a person put back in, which is still a transfer.
			row(
				`(865,${CHECKING},'2026-09-09',-50000,'TRANSFER FROM SAVINGS',NULL,0,1,1,0,NULL,NULL,1)`,
			),
			row(
				`(866,${CHECKING},'2026-09-10',-7000,'TRANSFER KEPT',NULL,0,1,0,0,NULL,NULL,1)`,
			),
			// A split refund counts by its parts, not its parent.
			row(
				`(867,${CARD},'2026-09-11',-4000,'SPLIT REFUND',NULL,0,0,0,1,NULL,NULL,1)`,
			),
			row(
				`(868,${CARD},'2026-09-11',-2500,'SPLIT REFUND',1,0,0,0,0,867,NULL,1),(869,${CARD},'2026-09-11',-1500,'SPLIT REFUND',4,0,0,0,0,867,NULL,1)`,
			),
			row(
				`(870,${CARD},'2026-09-12',1000,'PLAIN PURCHASE',1,0,0,0,0,NULL,NULL,NULL)`,
			),
		]);
	});

	it("Show Income lists only rows flagged income", async () => {
		const income = await listAll("month=2026-09&show=income");
		expect(income.length).toBeGreaterThan(1);
		expect(income.every((row) => row.income)).toBe(true);
		expect(income.map((row) => row.id)).toContain(860);
		const flagged = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE flag_income = 1 AND date LIKE '2026-09-%'",
		).first<{ n: number }>();
		expect(income).toHaveLength(flagged?.n ?? -1);
	});

	it("Show Refunds lists money in that isn't income or a transfer", async () => {
		const refunds = await ids("month=2026-09&show=refunds");
		// The linked refund, the unlinked one, the unreviewed credit, and the split refund's parts.
		expect(refunds).toEqual(expect.arrayContaining([862, 863, 864, 868, 869]));
		// Not a paycheck flagged income, a transfer (left out or put back), a purchase, or a split parent.
		for (const id of [860, 861, 865, 866, 867, 870]) {
			expect(refunds, `row ${id}`).not.toContain(id);
		}
		const rows = await listAll("month=2026-09&show=refunds");
		expect(
			rows.every((r) => r.amountCents < 0 && !r.income && !r.excluded),
		).toBe(true);
	});

	it("Show Refunds leaves out the demo's excluded reimbursement, which Excluded shows", async () => {
		const refunds = (await listAll("month=2026-09&show=refunds")).map(
			(r) => r.displayName,
		);
		expect(refunds).not.toContain("Reimbursement, doctor's office");
		const excluded = (await listAll("month=2026-09&show=excluded")).map(
			(r) => r.displayName,
		);
		expect(excluded).toContain("Reimbursement, doctor's office");
	});

	it("Show Spending is what Home counts", async () => {
		const spending = await listAll("month=2026-09&show=spending");
		const listed = new Set(spending.map((r) => r.id));
		// A purchase, a refund that follows it, a reviewed credit and a split's parts count; the unreviewed
		// credit, the paycheck, the transfer and a split's parent don't.
		for (const id of [861, 862, 863, 868, 869, 870]) {
			expect(listed.has(id), `row ${id}`).toBe(true);
		}
		for (const id of [860, 864, 865, 867]) {
			expect(listed.has(id), `row ${id}`).toBe(false);
		}
		expect(spending.some((r) => r.income || r.excluded)).toBe(false);
		const data = await loadMonth(env.DB, "2026-09");
		const home = summarizeMonth({
			month: "2026-09",
			...data,
			unpaidDueBillsCents: 0,
		});
		expect(spending.reduce((sum, r) => sum + r.amountCents, 0)).toBe(
			home.totalSpentCents,
		);
	});

	it("Show Excluded matches the old Excluded filter", async () => {
		const shown = await listAll("month=all&show=excluded");
		const stored = await env.DB.prepare(
			"SELECT id FROM transactions WHERE excluded = 1 ORDER BY date DESC, id DESC",
		).all<{ id: number }>();
		expect(shown.map((r) => r.id)).toEqual(stored.results.map((r) => r.id));
		expect(shown.map((r) => r.id)).toContain(865);
		// A link made when Excluded was a chip still shows the same rows.
		expect((await listAll("month=all&excluded=1")).map((r) => r.id)).toEqual(
			shown.map((r) => r.id),
		);
	});

	it("Show All lists every kind", async () => {
		const all = await ids("month=2026-09&show=all");
		expect(all).toEqual(await ids("month=2026-09"));
		expect(all).toEqual(expect.arrayContaining([860, 861, 862, 864, 865]));
	});

	it("combines with the account and the category", async () => {
		const inChecking = await ids(
			`month=2026-09&show=refunds&account=${CHECKING}`,
		);
		expect(inChecking).toContain(864);
		expect(inChecking).not.toContain(862);
		expect(
			await ids(`month=2026-09&show=refunds&account=${CARD}&category=1`),
		).toEqual(expect.arrayContaining([862, 863, 868]));
	});
});

describe("accountChoices", () => {
	it("lists every account once, named as the edit panel names it, with Cash last", async () => {
		expect(await accountChoices(env.DB)).toEqual([
			{ id: 1, label: "Checking ••1234", disconnected: false },
			{ id: 2, label: "Savings ••5678", disconnected: false },
			{ id: 3, label: "Credit card ••9012", disconnected: false },
			{ id: 4, label: "Cash", disconnected: false },
		]);
	});

	it("lists a disconnected bank's accounts too, marked, and its transactions stay filterable", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = 2",
		).run();
		const choices = await accountChoices(env.DB);
		expect(choices.map((c) => [c.id, c.disconnected])).toEqual([
			[1, false],
			[2, false],
			[3, true],
			[4, false],
		]);
		// Its transactions stay (spec §8.1), so the filter finds them.
		expect((await listAll(`month=all&account=${CARD}`)).length).toBeGreaterThan(
			0,
		);
	});

	it("reads Cash as Cash whatever it's stored as, and drops a missing mask", async () => {
		await env.DB.prepare(
			"UPDATE accounts SET name = 'Wallet' WHERE type = 'cash'",
		).run();
		await env.DB.prepare("UPDATE accounts SET mask = NULL WHERE id = 1").run();
		const choices = await accountChoices(env.DB);
		expect(choices.find((c) => c.id === CASH)?.label).toBe("Cash");
		expect(choices.find((c) => c.id === CHECKING)?.label).toBe("Checking");
	});
});
