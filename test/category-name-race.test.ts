import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { makeCategory, saveCategory } from "../src/db/categories";
import { resetDemo } from "../src/demo/reset";

// Two saves at once can't both file a name that differs only in accented capitals ("Café" and "CAFÉ"):
// the unique name_key index refuses the second write (migration 0052), and the answer is the usual error.

const db = env.DB;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
});

const rowsWithKey = async (key: string) =>
	(
		await db
			.prepare("SELECT name FROM categories WHERE name_key = ?")
			.bind(key)
			.all<{ name: string }>()
	).results;

describe("two creates of names that differ only in accented capitals, at the same moment", () => {
	it("files one and refuses the other with the usual error", async () => {
		const outcomes = await Promise.all([
			makeCategory(db, { name: "Café" }),
			makeCategory(db, { name: "CAFÉ" }),
		]);
		expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
		expect(outcomes).toContainEqual({
			ok: false,
			error: "That name is taken.",
		});
		expect(await rowsWithKey("café")).toHaveLength(1);
	});
});

describe("a rename and a create of names that differ only in accented capitals, at the same moment", () => {
	it("files one and refuses the other", async () => {
		const pet = await makeCategory(db, { name: "Pet" });
		if (!pet.ok) throw new Error("Could not make the test category");
		const outcomes = await Promise.allSettled([
			saveCategory(db, pet.id, { name: "CAFÉ" }),
			makeCategory(db, { name: "Café" }),
		]);
		const [renamed, created] = outcomes;
		const renameFiled = renamed.status === "fulfilled";
		const createFiled =
			created.status === "fulfilled" && created.value.ok === true;
		expect(renameFiled !== createFiled).toBe(true);
		if (renamed.status === "rejected")
			expect(String(renamed.reason)).toMatch(/UNIQUE/);
		expect(await rowsWithKey("café")).toHaveLength(1);
	});
});

describe("demo reset", () => {
	it("gives every category the key the form would compare it by", async () => {
		const { results } = await db
			.prepare("SELECT name, name_key FROM categories WHERE name = 'Groceries'")
			.all<{ name: string; name_key: string }>();
		expect(results).toEqual([{ name: "Groceries", name_key: "groceries" }]);
	});
});
