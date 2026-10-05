import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	activateBill,
	type BillFields,
	insertBill,
	updateBill,
} from "../src/bills/write";
import { todayUtc } from "../src/dates";
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
	beforeEach(() => resetDemo(env.DB, todayUtc()));

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

		it("refuses an inactive bill's rename to an active bill's name, and allows a free one", async () => {
			expect(
				await updateBill(env.DB, 7, fields({ name: "Water" }), false),
			).toBe(false);
			expect(
				await updateBill(env.DB, 7, fields({ name: "Old phone" }), false),
			).toBe(true);
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
