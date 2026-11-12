import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { merchantDisplayNames } from "../src/db/merchant-names";
import { clearMerchants, seedMerchant } from "./helpers/merchants";

// merchantDisplayNames reads the display names the merchants table has for raw merchant keys, in one query. A key with
// a row that has no display name maps to null; a key with no row is not in the Map at all.

const db = env.DB;

beforeEach(async () => {
	await clearMerchants(db);
});

describe("merchantDisplayNames", () => {
	it("returns an empty Map for no keys, without reading anything", async () => {
		expect(await merchantDisplayNames(db, [])).toEqual(new Map());
	});

	it("maps a key with a display name to it, and a key with a row but no display name to null", async () => {
		await seedMerchant(db, { key: "NETFLIX.COM", displayName: "Netflix" });
		await seedMerchant(db, { key: "HULU", displayName: null });

		const names = await merchantDisplayNames(db, ["NETFLIX.COM", "HULU"]);

		expect(names.get("NETFLIX.COM")).toBe("Netflix");
		expect(names.get("HULU")).toBeNull();
		expect(names.size).toBe(2);
	});

	it("leaves out a key with no row, and ignores rows for keys that were not asked for", async () => {
		await seedMerchant(db, { key: "NETFLIX.COM", displayName: "Netflix" });
		await seedMerchant(db, { key: "SPOTIFY", displayName: "Spotify" });

		const names = await merchantDisplayNames(db, ["NETFLIX.COM", "NOT A ROW"]);

		expect([...names.entries()]).toEqual([["NETFLIX.COM", "Netflix"]]);
		expect(names.has("SPOTIFY")).toBe(false);
	});

	it("answers 150 keys in one call, past the 100 values D1 allows one statement to bind", async () => {
		const keys = Array.from({ length: 150 }, (_, i) => `MERCHANT ${i}`);

		for (const [i, key] of keys.entries()) {
			if (i % 2 === 0)
				await seedMerchant(db, { key, displayName: `Shop ${i}` });
		}

		const names = await merchantDisplayNames(db, keys);

		// Only the 75 even keys have a row, so only they are in the Map.
		expect(names.size).toBe(75);
		expect(names.get("MERCHANT 0")).toBe("Shop 0");
		expect(names.get("MERCHANT 148")).toBe("Shop 148");
		expect(names.has("MERCHANT 1")).toBe(false);
		expect(names.has("MERCHANT 149")).toBe(false);
	});
});
