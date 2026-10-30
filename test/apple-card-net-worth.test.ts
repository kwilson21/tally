import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	accountChoices,
	appleCardAccount,
	countedAccounts,
	netWorthCents,
} from "../src/db/accounts";
import { accountsWithHistory } from "../src/db/balance-history";
import { resetDemo } from "../src/demo/reset";

// Apple Card in net worth (spec §8.10, #766): the card counts once a balance is typed and it isn't removed, from the
// day its balance counted, in the headline, the chart and How Tally works' example alike.

const TODAY = "2026-10-05";

/** The demo's headline on TODAY, from the balance-history tests: its banks alone. */
const BANKS_NET_WORTH_TODAY = 1576838;

async function addCard(fields: {
	balanceCents?: number;
	balanceOn?: string | null;
	countedFrom?: string | null;
	removedAt?: string | null;
}) {
	await env.DB.prepare(
		`INSERT INTO accounts (name, type, subtype, is_liability, balance_cents, balance_on, counted_from, uploaded_on, removed_at)
		VALUES ('Apple Card', 'credit', 'apple_card', 1, ?, ?, ?, ?, ?)`,
	)
		.bind(
			fields.balanceCents ?? 0,
			fields.balanceOn ?? null,
			fields.countedFrom ?? null,
			TODAY,
			fields.removedAt ?? null,
		)
		.run();
	return env.DB.prepare(
		"SELECT id FROM accounts WHERE subtype = 'apple_card'",
	).first<{ id: number }>();
}

async function addCardBalances(
	accountId: number,
	dates: string[],
	cents: number,
) {
	for (const date of dates)
		await env.DB.prepare(
			"INSERT INTO balance_history (account_id, date, balance_cents) VALUES (?, ?, ?)",
		)
			.bind(accountId, date, cents)
			.run();
}

const DAYS_OCT = [
	"2026-10-01",
	"2026-10-02",
	"2026-10-03",
	"2026-10-04",
	"2026-10-05",
];

/** The line's cents on one day, or undefined when it has no point that day. */
const on = (points: { date: string; cents: number }[], date: string) =>
	points.find((p) => p.date === date)?.cents;

describe("Apple Card in net worth (spec §8.10)", () => {
	beforeEach(() => resetDemo(env.DB, TODAY));

	it("counts the card in the headline and the chart from its counted day, and it adds to the banks", async () => {
		const without = await accountsWithHistory(env.DB, TODAY);
		const card = await addCard({
			balanceCents: 124018,
			balanceOn: TODAY,
			countedFrom: "2026-10-01",
		});
		await addCardBalances(card?.id ?? 0, DAYS_OCT, 124018);
		const { banks, points, appleCard, added } = await accountsWithHistory(
			env.DB,
			TODAY,
		);
		expect(appleCard).toMatchObject({
			balanceCents: 124018,
			balanceOn: TODAY,
			removedAt: null,
		});
		const counted = countedAccounts(banks, appleCard);
		expect(netWorthCents(counted)).toBe(BANKS_NET_WORTH_TODAY - 124018);
		// The line keeps the past months from the window's first day, steps down on the card's counted day by
		// what it owes, ends on the headline, and names the card for that day.
		expect(points[0]?.date).toBe("2026-05-01");
		expect(points).toHaveLength(158);
		expect(on(points, "2026-09-30")).toBe(on(without.points, "2026-09-30"));
		expect(on(points, "2026-10-01")).toBe(
			(on(without.points, "2026-10-01") ?? 0) - 124018,
		);
		expect(points.at(-1)).toEqual({
			date: TODAY,
			cents: BANKS_NET_WORTH_TODAY - 124018,
		});
		expect(added).toEqual([
			{ name: "Apple Card", verb: "added", date: "2026-10-01" },
		]);
	});

	it("reads the card's balances only from its counted day on, so an older balance never carries into the line", async () => {
		const without = await accountsWithHistory(env.DB, TODAY);
		const card = await addCard({
			balanceCents: 124018,
			balanceOn: TODAY,
			countedFrom: "2026-10-01",
		});
		// A balance from before the card counted (a removal's gap, say) must not reach the line.
		await addCardBalances(card?.id ?? 0, ["2026-09-01"], 999999);
		await addCardBalances(card?.id ?? 0, DAYS_OCT, 124018);
		const { points } = await accountsWithHistory(env.DB, TODAY);
		expect(points[0]?.date).toBe("2026-05-01");
		// September's line is the banks' alone: the card's older balance never reached it.
		expect(on(points, "2026-09-01")).toBe(on(without.points, "2026-09-01"));
		expect(points.at(-1)?.cents).toBe(BANKS_NET_WORTH_TODAY - 124018);
	});

	it("leaves a removed card out of the headline, the chart and the counted accounts, and keeps its rows", async () => {
		const before = await accountsWithHistory(env.DB, TODAY);
		const card = await addCard({
			balanceCents: 124018,
			balanceOn: null,
			countedFrom: "2026-10-01",
			removedAt: "2026-10-03 10:00:00",
		});
		await addCardBalances(card?.id ?? 0, DAYS_OCT, 124018);
		const after = await accountsWithHistory(env.DB, TODAY);
		expect(after.appleCard?.removedAt).toBe("2026-10-03 10:00:00");
		expect(countedAccounts(after.banks, after.appleCard)).toEqual(
			countedAccounts(before.banks, null),
		);
		expect(after.points).toEqual(before.points);
	});

	it("leaves a card with no balance typed out of net worth, and its line unchanged, until one is", async () => {
		const before = await accountsWithHistory(env.DB, TODAY);
		await addCard({ balanceCents: 0, balanceOn: null, countedFrom: null });
		const after = await accountsWithHistory(env.DB, TODAY);
		expect(after.appleCard).toMatchObject({ balanceOn: null, removedAt: null });
		expect(netWorthCents(countedAccounts(after.banks, after.appleCard))).toBe(
			netWorthCents(countedAccounts(before.banks, null)),
		);
		expect(after.points).toEqual(before.points);
		expect(after.added).toEqual(before.added);
	});

	it("adds a credit balance to net worth, since the card then owes the family", async () => {
		const card = await addCard({
			balanceCents: -1200,
			balanceOn: TODAY,
			countedFrom: TODAY,
		});
		await addCardBalances(card?.id ?? 0, [TODAY], -1200);
		const { banks, appleCard } = await accountsWithHistory(env.DB, TODAY);
		expect(
			netWorthCents(countedAccounts(banks, appleCard)) -
				netWorthCents(countedAccounts(banks, null)),
		).toBe(1200);
	});

	it("reads the card's last transaction as the day it's through, and no card as no account", async () => {
		expect(await appleCardAccount(env.DB)).toBeNull();
		const card = await addCard({
			balanceCents: 124018,
			balanceOn: TODAY,
			countedFrom: TODAY,
		});
		expect((await appleCardAccount(env.DB))?.through).toBeNull();
		await env.DB.prepare(
			`INSERT INTO transactions (account_id, date, amount_cents, raw_name)
			VALUES (?, '2026-10-02', 1000, 'A'), (?, '2026-10-04', 2000, 'B')`,
		)
			.bind(card?.id ?? 0, card?.id ?? 0)
			.run();
		expect((await appleCardAccount(env.DB))?.through).toBe("2026-10-04");
	});
});

describe("Transactions' Account choice with Apple Card (#766)", () => {
	beforeEach(() => resetDemo(env.DB, TODAY));

	it("lists the card after the banks, as Accounts does, and Cash last", async () => {
		await addCard({
			balanceCents: 124018,
			balanceOn: TODAY,
			countedFrom: TODAY,
		});
		const choices = await accountChoices(env.DB);
		const labels = choices.map((choice) => choice.label);
		const card = labels.indexOf("Apple Card");
		const lastBank = Math.max(
			...labels.map((label, i) =>
				label !== "Apple Card" && label !== "Cash" ? i : -1,
			),
		);
		expect(card).toBe(lastBank + 1);
		expect(labels.at(-1)).toBe("Cash");
	});
});
