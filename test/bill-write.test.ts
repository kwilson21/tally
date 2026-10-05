import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { duplicateBillName } from "../src/bills/guards";
import {
	activateBill,
	type BillFields,
	insertBill,
	updateBill,
} from "../src/bills/write";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// The writes enforce "no two active bills share a name" themselves (spec §8.5), so two saves that
// both passed the form's check can't both land. The demo has Streaming (1), Water (2), Electric (3),
// Internet (5) and Soccer league (6) active, and Old phone plan (7) inactive.
const fields = (over: Partial<BillFields> = {}): BillFields => ({
	name: "Gym",
	amountCents: 4250,
	dueDay: 12,
	frequency: "monthly",
	anchorMonth: null,
	categoryId: 5,
	merchantRawName: "CITY GYM",
	...over,
});
const count = async (where = "1=1") =>
	(
		await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM bills WHERE ${where}`,
		).first<{
			n: number;
		}>()
	)?.n;
const row = (id: number) =>
	env.DB.prepare("SELECT name,amount_cents,active FROM bills WHERE id=?")
		.bind(id)
		.first<{ name: string; amount_cents: number; active: number }>();

describe("bill writes", () => {
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

	describe("insertBill", () => {
		it("adds a bill with a free name", async () => {
			expect(await insertBill(env.DB, fields())).toBe(true);
			const added = await env.DB.prepare(
				"SELECT * FROM bills WHERE name='Gym'",
			).first<Record<string, unknown>>();
			expect(added).toMatchObject({
				amount_cents: 4250,
				due_day: 12,
				frequency: "monthly",
				anchor_month: null,
				category_id: 5,
				merchant_raw_name: "CITY GYM",
				active: 1,
			});
		});

		it.each(["Water", "water", "  WATER  "])(
			"writes nothing when an active bill is already called %j",
			async (name) => {
				const before = await count();
				expect(await insertBill(env.DB, fields({ name }))).toBe(false);
				expect(await count()).toBe(before);
			},
		);

		it("adds a bill with an inactive bill's name", async () => {
			expect(await insertBill(env.DB, fields({ name: "old phone plan" }))).toBe(
				true,
			);
			expect(await count("active=1 AND name='old phone plan'")).toBe(1);
		});

		it("keeps a yearly bill's anchor month", async () => {
			expect(
				await insertBill(
					env.DB,
					fields({ name: "Tax", frequency: "yearly", anchorMonth: 4 }),
				),
			).toBe(true);
			expect(
				await env.DB.prepare(
					"SELECT anchor_month FROM bills WHERE name='Tax'",
				).first("anchor_month"),
			).toBe(4);
		});
	});

	// The form's check and these writes must call the same pairs of names the same: otherwise two saves
	// racing past the form could leave two active bills it would have refused.
	describe("the same names as the form's check", () => {
		it.each([
			["rent", " RENT ", true],
			["Rent", "rent", true],
			["Rent", "Rent 2", false],
			["Café", "CAFÉ", false],
			["Café", "CAFé", true],
			["Café", "café", true],
			["Straße", "STRASSE", false],
			["İstanbul", "istanbul", false],
			["Rent\t", "Rent", false],
			["Rent\t", "rent\t", true],
			["Rent ", "Rent", false],
		])(
			"%j and %j: duplicates is %s, in both",
			async (existing, typed, same) => {
				await env.DB.prepare(
					`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
				 VALUES(?,1000,1,'monthly',5,'RIVAL CO')`,
				)
					.bind(existing)
					.run();
				const active = (
					await env.DB.prepare("SELECT id,name,active FROM bills").all<{
						id: number;
						name: string;
						active: number;
					}>()
				).results;
				expect(duplicateBillName(active, typed) !== undefined).toBe(same);
				expect(await insertBill(env.DB, fields({ name: typed }))).toBe(!same);
				await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			},
		);
	});

	describe("updateBill", () => {
		it("changes a bill that keeps its own name", async () => {
			expect(
				await updateBill(env.DB, 1, fields({ name: "streaming" }), false),
			).toBe(true);
			expect(await row(1)).toMatchObject({
				name: "streaming",
				amount_cents: 4250,
			});
		});

		it("writes nothing when the new name is another active bill's", async () => {
			expect(
				await updateBill(env.DB, 1, fields({ name: " WATER" }), false),
			).toBe(false);
			expect(await row(1)).toMatchObject({
				name: "Streaming",
				amount_cents: 299,
			});
		});

		describe("bills that already share a name", () => {
			// Two active Rent bills, as a family's data may already hold. Ids 8 and 9.
			beforeEach(async () => {
				for (const merchant of ["LANDLORD", "LANDLORD 2"])
					await env.DB.prepare(
						`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
						 VALUES('Rent',100000,1,'monthly',5,?)`,
					)
						.bind(merchant)
						.run();
			});

			it.each([8, 9])(
				"still saves bill %i with its name unchanged",
				async (id) => {
					expect(
						await updateBill(
							env.DB,
							id,
							fields({ name: "Rent", amountCents: 120000 }),
							false,
						),
					).toBe(true);
					expect(await row(id)).toMatchObject({
						name: "Rent",
						amount_cents: 120000,
					});
				},
			);

			it("counts a name that differs only by case or surrounding spaces as unchanged", async () => {
				expect(
					await updateBill(env.DB, 8, fields({ name: " rent " }), false),
				).toBe(true);
				expect(await row(8)).toMatchObject({ name: " rent " });
			});

			it.each([8, 9])(
				"still refuses renaming bill %i to a third bill's name",
				async (id) => {
					expect(
						await updateBill(env.DB, id, fields({ name: "water" }), false),
					).toBe(false);
					expect(await row(id)).toMatchObject({ name: "Rent" });
				},
			);

			it("keeps clearing dismissals when its schedule changes, name unchanged", async () => {
				const transaction = await env.DB.prepare(
					"SELECT id FROM transactions WHERE id NOT IN (SELECT transaction_id FROM bill_payments WHERE status='linked') LIMIT 1",
				).first<{ id: number }>();
				await env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(8,'2020-01',?,'user','dismissed')",
				)
					.bind(transaction?.id)
					.run();
				expect(
					await updateBill(
						env.DB,
						8,
						fields({ name: "Rent", frequency: "yearly", anchorMonth: 3 }),
						true,
					),
				).toBe(true);
				expect(
					await env.DB.prepare(
						"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=8",
					).first("n"),
				).toBe(0);
			});

			it("does not let a new bill or a reactivation take the shared name", async () => {
				expect(await insertBill(env.DB, fields({ name: "rent" }))).toBe(false);
				await env.DB.prepare("UPDATE bills SET active=0 WHERE id=9").run();
				expect(await activateBill(env.DB, 9, "Rent")).toBe(false);
			});
		});

		it("refuses an inactive bill's rename to an active bill's name, and allows a free one", async () => {
			expect(
				await updateBill(env.DB, 7, fields({ name: "Water" }), false),
			).toBe(false);
			expect(
				await updateBill(env.DB, 7, fields({ name: "Old phone" }), false),
			).toBe(true);
		});

		it("excludes a Plaid transfer again when a changed schedule drops its link", async () => {
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9200,'Mortgage',150000,1,'monthly',5,'LANDLORD LLC')",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,plaid_category) SELECT 9201,id,'2026-09-01',150000,'LANDLORD LLC','TRANSFER_OUT' FROM accounts LIMIT 1",
				),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9200,'2026-09',9201,'user','linked')",
				),
			]);
			expect(
				await updateBill(
					env.DB,
					9200,
					fields({ name: "Mortgage", frequency: "yearly", anchorMonth: 3 }),
					true,
				),
			).toBe(true);
			expect(
				await env.DB.prepare(
					"SELECT excluded, excluded_source FROM transactions WHERE id=9201",
				).first(),
			).toEqual({ excluded: 1, excluded_source: "plaid" });
		});

		it("keeps the old dismissals when a changed schedule's rename is refused", async () => {
			const transaction = await env.DB.prepare(
				"SELECT id FROM transactions WHERE id NOT IN (SELECT transaction_id FROM bill_payments WHERE status='linked') LIMIT 1",
			).first<{ id: number }>();
			await env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(2,'2020-01',?,'user','dismissed')",
			)
				.bind(transaction?.id)
				.run();
			const dismissed = () =>
				env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=2 AND status='dismissed'",
				).first("n");
			// A refused save keeps its dismissals, as it keeps everything else.
			expect(
				await updateBill(
					env.DB,
					2,
					fields({ name: "Electric", frequency: "yearly", anchorMonth: 3 }),
					true,
				),
			).toBe(false);
			expect(await dismissed()).toBe(1);
			expect(
				await env.DB.prepare("SELECT frequency FROM bills WHERE id=2").first(
					"frequency",
				),
			).toBe("monthly");
			// An allowed one clears them, since period keys change shape with the schedule.
			expect(
				await updateBill(
					env.DB,
					2,
					fields({ name: "Water", frequency: "yearly", anchorMonth: 3 }),
					true,
				),
			).toBe(true);
			expect(await dismissed()).toBe(0);
		});
	});

	describe("activateBill", () => {
		it("reactivates an inactive bill whose name is free", async () => {
			expect(await activateBill(env.DB, 7, "Old phone plan")).toBe(true);
			expect(await row(7)).toMatchObject({
				name: "Old phone plan",
				active: 1,
			});
		});

		it("renames it in the same write", async () => {
			expect(await activateBill(env.DB, 7, "Phone, 2024")).toBe(true);
			expect(await row(7)).toMatchObject({ name: "Phone, 2024", active: 1 });
		});

		it("changes nothing when an active bill has the name", async () => {
			await insertBill(env.DB, fields({ name: "old phone plan" }));
			expect(await activateBill(env.DB, 7, "Old phone plan")).toBe(false);
			expect(await activateBill(env.DB, 7, "WATER")).toBe(false);
			expect(await row(7)).toMatchObject({
				name: "Old phone plan",
				active: 0,
			});
		});

		it("changes nothing for a bill that doesn't exist", async () => {
			expect(await activateBill(env.DB, 999999, "Nothing")).toBe(false);
		});
	});
});
