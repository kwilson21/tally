import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { saveAskedNames, suggestBankNames } from "../src/db/merchant-names";
import {
	assertMerchantInvariants,
	clearMerchants,
	merchantNames,
} from "./helpers/merchants";

// A name is trimmed when it is stored, so a key with spaces around it could never equal its own name: the bank's-own-name
// test (name = key) would fail, and the row would be half written. A padded text is skipped instead, and the rest land.
const db = env.DB;

const rawNamesOf = async () =>
	(
		await db
			.prepare("SELECT raw_name FROM merchants ORDER BY raw_name")
			.all<{ raw_name: string }>()
	).results.map((row) => row.raw_name);

describe("a padded bank text is never suggested", () => {
	it("suggestBankNames writes no merchant row and no names for a padded value, and the clean one lands", async () => {
		await clearMerchants(db);
		await db.batch(suggestBankNames(db, [" Padded Co ", "Clean Co"], "1", []));
		expect(await rawNamesOf()).toEqual(["Clean Co"]);
		expect(await merchantNames(db, " Padded Co ")).toEqual([]);
		expect(await merchantNames(db, "Clean Co")).toEqual(["Clean Co"]);
		await assertMerchantInvariants(db);
	});

	it("saveAskedNames skips a padded text: no row and no names, and the other answer is counted and kept", async () => {
		await clearMerchants(db);
		const suggested = await saveAskedNames(
			db,
			[
				{ rawName: " Padded Co ", names: ["Padded Co"] },
				{ rawName: "Clean Co", names: ["Clean Co"] },
			],
			[],
		);
		expect(suggested).toBe(1);
		expect(await rawNamesOf()).toEqual(["Clean Co"]);
		expect(await merchantNames(db, "Clean Co")).toEqual(["Clean Co"]);
		await assertMerchantInvariants(db);
	});
});
