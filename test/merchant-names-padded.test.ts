import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	merchantsToAsk,
	saveAskedNames,
	settleSuggestion,
	suggestBankNames,
} from "../src/db/merchant-names";
import { resetDemo } from "../src/demo/reset";
import {
	assertMerchantInvariants,
	clearMerchants,
	merchantNames,
} from "./helpers/merchants";

// Two different rules for spaces around a bank text. A BANK-SENT name must equal its merchant key (a bank name is the key,
// name = key), and a name is stored trimmed, so a padded bank-sent key is skipped: no row, no names. A padded text that
// Workers AI is asked about keeps its key as it is (the merchant row is made under the padded text, as before); only the
// names it answers with are trimmed and kept in order, and an empty key is refused.
const db = env.DB;

const rawNamesOf = async () =>
	(
		await db
			.prepare("SELECT raw_name FROM merchants ORDER BY raw_name")
			.all<{ raw_name: string }>()
	).results.map((row) => row.raw_name);

describe("a padded bank-sent name is never suggested", () => {
	it("suggestBankNames writes no merchant row and no names for a padded value, and the clean one lands", async () => {
		await clearMerchants(db);
		await db.batch(suggestBankNames(db, [" Padded Co ", "Clean Co"], "1", []));
		expect(await rawNamesOf()).toEqual(["Clean Co"]);
		expect(await merchantNames(db, " Padded Co ")).toEqual([]);
		expect(await merchantNames(db, "Clean Co")).toEqual(["Clean Co"]);
		await assertMerchantInvariants(db);
	});
});

describe("a padded text Workers AI is asked about keeps its key (the names are trimmed, not the key)", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		// A charge whose bank text is padded and which Plaid named nothing for, so the nightly names step asks about it.
		await db
			.prepare(
				`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, merchant_name)
				 VALUES ('padded-text-1', 1, '2026-09-20', 650, ' Padded Co ', NULL)`,
			)
			.run();
	});

	it("an answer with names creates a pending row under the padded key, with the names trimmed and in order", async () => {
		expect(await merchantsToAsk(db, 1000)).toContain(" Padded Co ");
		const suggested = await saveAskedNames(
			db,
			[{ rawName: " Padded Co ", names: ["  Padded Co  ", " Padded Two", ""] }],
			[],
		);
		expect(suggested).toBe(1);
		expect(
			await db
				.prepare(
					"SELECT suggestion_status AS status, names_asked AS asked FROM merchants WHERE raw_name = ?",
				)
				.bind(" Padded Co ")
				.first(),
		).toEqual({ status: "pending", asked: 0 });
		expect(await merchantNames(db, " Padded Co ")).toEqual([
			"Padded Co",
			"Padded Two",
		]);
		expect(await merchantsToAsk(db, 1000)).not.toContain(" Padded Co ");
		await assertMerchantInvariants(db);
	});

	it("an empty answer sets names_asked under the padded key, so the text is not asked again", async () => {
		await saveAskedNames(db, [{ rawName: " Padded Co ", names: ["  "] }], []);
		expect(
			await db
				.prepare(
					"SELECT suggestion_status AS status, names_asked AS asked FROM merchants WHERE raw_name = ?",
				)
				.bind(" Padded Co ")
				.first(),
		).toEqual({ status: "none", asked: 1 });
		expect(await merchantNames(db, " Padded Co ")).toEqual([]);
		expect(await merchantsToAsk(db, 1000)).not.toContain(" Padded Co ");
		await assertMerchantInvariants(db);
	});

	it("a person can pick one of the names for the padded merchant, and it is accepted", async () => {
		await saveAskedNames(
			db,
			[{ rawName: " Padded Co ", names: ["Padded Co", "Padded Two"] }],
			[],
		);
		expect(
			await settleSuggestion(db, " Padded Co ", {
				kind: "name",
				name: "Padded Two",
			}),
		).toBe(true);
		expect(
			await db
				.prepare(
					"SELECT display_name AS display, suggestion_status AS status FROM merchants WHERE raw_name = ?",
				)
				.bind(" Padded Co ")
				.first(),
		).toEqual({ display: "Padded Two", status: "accepted" });
		await assertMerchantInvariants(db);
	});

	it("an empty key is still refused, and the other answer is counted", async () => {
		const suggested = await saveAskedNames(
			db,
			[
				{ rawName: "", names: ["Nothing"] },
				{ rawName: "Clean Co", names: ["Clean Co"] },
			],
			[],
		);
		expect(suggested).toBe(1);
		expect(await merchantNames(db, "")).toEqual([]);
		await assertMerchantInvariants(db);
	});
});
