import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
	databaseRefusal,
	NotNullFailed,
	TableMissing,
	TriggerRaised,
} from "../src/db/refused";
import { PaysAPlannedExpense } from "../src/rules/bills";
import { present } from "./helpers/present";

// What the database itself says when it stops a write, read off the real database. The code that reacts to a refusal asks
// for its kind and its parts, never its text, so a reworded message fails here and nowhere else.

/** The refusal the database gives for these statements, run as one batch. */
async function refusalOf(statements: D1PreparedStatement[]) {
	try {
		await env.DB.batch(statements);
	} catch (error) {
		return error instanceof Error ? databaseRefusal(error) : null;
	}

	return null;
}

it("names a missing table", async () => {
	expect(
		await refusalOf([env.DB.prepare("SELECT * FROM not_a_table")]),
	).toEqual(new TableMissing({ table: "not_a_table" }));
});

it("names the table and column of a value that must not be empty", async () => {
	expect(
		await refusalOf([
			env.DB.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('refusal_probe', NULL)",
			),
		]),
	).toEqual(
		new NotNullFailed({ table: "household_settings", column: "value" }),
	);
});

it("gives a trigger's own words, which are the bill rule's words for a payment that pays a planned expense", async () => {
	const account = present(
		await env.DB.prepare(
			"INSERT INTO accounts (name, type, balance_cents) VALUES ('Probe', 'depository', 0) RETURNING id",
		).first<{ id: number }>(),
	).id;

	const payment = present(
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (?, '2026-10-01', 1200, 'PROBE') RETURNING id",
		)
			.bind(account)
			.first<{ id: number }>(),
	).id;

	const bill = present(
		await env.DB.prepare(
			"INSERT INTO bills (name, amount_cents, due_day, frequency, merchant_raw_name) VALUES ('Probe bill', 1200, 1, 'monthly', 'PROBE') RETURNING id",
		).first<{ id: number }>(),
	).id;

	await env.DB.prepare(
		"INSERT INTO planned_expenses (name, amount_cents, month, transaction_id, created_by) VALUES ('Probe plan', 1200, '2026-10', ?, 'demo')",
	)
		.bind(payment)
		.run();

	expect(
		await refusalOf([
			env.DB.prepare(
				"INSERT INTO bill_payments (bill_id, period, transaction_id, matched_by, status) VALUES (?, '2026-10', ?, 'user', 'linked')",
			).bind(bill, payment),
		]),
	).toEqual(new TriggerRaised({ words: new PaysAPlannedExpense().say }));
});

it("names nothing for an error that is not the database stopping a write", () => {
	expect(
		databaseRefusal(new Error("D1_ERROR: Network connection lost.")),
	).toBeNull();
});
