import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import { merchants } from "../../spike/drizzle/schema";

const orm = drizzle(env.DB);
const names = JSON.stringify(["NEW ONE", "NAMED"]);
beforeEach(async () => {
	await env.DB.prepare("DELETE FROM merchants").run();
	await env.DB.prepare("INSERT INTO merchants (raw_name, display_name) VALUES ('NAMED', 'Mine')").run();
});
const upsert = {
	target: merchants.rawName,
	set: { suggestedName: sql`excluded.suggested_name`, suggestionStatus: "pending" as const },
	setWhere: sql`${merchants.displayName} IS NULL AND ${merchants.suggestionStatus} IN ('none', 'pending')`,
};
const expected = [["NAMED", "none", "Mine"], ["NEW ONE", "pending", null]];
const rows = async () => (await orm.select().from(merchants).orderBy(merchants.rawName)).map((r) => [r.rawName, r.suggestionStatus, r.displayName]);

describe("INSERT … SELECT json_each in Drizzle", () => {
	it("A: insert().select(sql) giving a value for every column", async () => {
		await orm.insert(merchants)
			.select(sql`SELECT value, value, NULL, NULL, 'pending', 0 FROM json_each(${names}) WHERE 1`)
			.onConflictDoUpdate(upsert);
		expect(await rows()).toEqual(expected);
	});
	it("B: json_each declared as a table, fully through the builder", async () => {
		const jsonEach = sqliteTable("json_each", { value: text().notNull() });
		await orm.insert(merchants)
			.select((qb) => qb.select({
				rawName: sql<string>`${jsonEach.value}`.as("raw_name"),
				suggestedName: sql<string>`${jsonEach.value}`.as("suggested_name"),
				displayName: sql<string | null>`NULL`.as("display_name"),
				defaultCategoryId: sql<number | null>`NULL`.as("default_category_id"),
				suggestionStatus: sql<"pending">`'pending'`.as("suggestion_status"),
				notABill: sql<number>`0`.as("not_a_bill"),
			}).from(sql`json_each(${names}) as json_each`).where(sql`1`) as never)
			.onConflictDoUpdate(upsert);
		expect(await rows()).toEqual(expected);
	});
});
