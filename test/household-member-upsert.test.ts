import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	noteHouseholdMember,
	removeHouseholdMember,
} from "../src/db/reconnect";

const EMAIL = "dana@example.com";
// 2026-01-01 00:00:00 UTC, the removal time every case below pins.
const REMOVED_AT = "2026-01-01 00:00:00";
const REMOVED_AT_UNIX = 1767225600;

type Row = {
	session_issued_at: number;
	removed_at: string | null;
	count: number;
};

async function row(email = EMAIL): Promise<Row | null> {
	return env.DB.prepare(
		"SELECT session_issued_at, removed_at, (SELECT COUNT(*) FROM household_members WHERE email = ?) AS count FROM household_members WHERE email = ?",
	)
		.bind(email, email)
		.first<Row>();
}

async function pinRemoval(email = EMAIL) {
	await env.DB.prepare(
		"UPDATE household_members SET removed_at = ? WHERE email = ?",
	)
		.bind(REMOVED_AT, email)
		.run();
}

describe("noteHouseholdMember", () => {
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM household_members").run();
	});

	it("adds a new member with the session time of the sign-in", async () => {
		await noteHouseholdMember(env.DB, EMAIL, 100);
		expect(await row()).toMatchObject({
			session_issued_at: 100,
			removed_at: null,
			count: 1,
		});
	});

	it("adds a first-time member with a null issue time as session 0", async () => {
		await noteHouseholdMember(env.DB, EMAIL, null);
		expect(await row()).toMatchObject({
			session_issued_at: 0,
			removed_at: null,
			count: 1,
		});
	});

	it("refreshes a current member to a newer session", async () => {
		await noteHouseholdMember(env.DB, EMAIL, 100);
		await noteHouseholdMember(env.DB, EMAIL, 150);
		expect(await row()).toMatchObject({ session_issued_at: 150, count: 1 });
	});

	it("never lowers a stored session to an older one", async () => {
		await noteHouseholdMember(env.DB, EMAIL, 200);
		await noteHouseholdMember(env.DB, EMAIL, 150);
		expect(await row()).toMatchObject({ session_issued_at: 200 });
	});

	it("keeps the stored session when a visit has no issue time", async () => {
		await noteHouseholdMember(env.DB, EMAIL, 200);
		await noteHouseholdMember(env.DB, EMAIL, null);
		expect(await row()).toMatchObject({
			session_issued_at: 200,
			removed_at: null,
			count: 1,
		});
	});

	it("does not restore a removed member on a visit with no issue time", async () => {
		await noteHouseholdMember(env.DB, EMAIL, 100);
		await removeHouseholdMember(env.DB, EMAIL);
		await noteHouseholdMember(env.DB, EMAIL, null);
		expect(await row()).toMatchObject({ session_issued_at: 100 });
		expect((await row())?.removed_at).not.toBeNull();
	});

	describe("a removed member comes back only for a session issued after removal", () => {
		it.each([
			["before the removal", REMOVED_AT_UNIX - 1, true],
			["exactly at the removal", REMOVED_AT_UNIX, true],
			["after the removal", REMOVED_AT_UNIX + 1, false],
		])(
			"issued %s: still removed = %s",
			async (_label, issuedAt, stillRemoved) => {
				await noteHouseholdMember(env.DB, EMAIL, 100);
				await removeHouseholdMember(env.DB, EMAIL);
				await pinRemoval();
				await noteHouseholdMember(env.DB, EMAIL, issuedAt);
				const found = await row();
				expect(found?.count).toBe(1);
				expect(found?.removed_at === null).toBe(!stillRemoved);
			},
		);
	});

	it("re-adds a removed member with the later session", async () => {
		await noteHouseholdMember(env.DB, EMAIL, 100);
		await removeHouseholdMember(env.DB, EMAIL);
		await pinRemoval();
		await noteHouseholdMember(env.DB, EMAIL, REMOVED_AT_UNIX + 60);
		expect(await row()).toMatchObject({
			session_issued_at: REMOVED_AT_UNIX + 60,
			removed_at: null,
			count: 1,
		});
	});

	it("repeated calls with the same data leave one unchanged row", async () => {
		await noteHouseholdMember(env.DB, EMAIL, 100);
		await noteHouseholdMember(env.DB, EMAIL, 100);
		await noteHouseholdMember(env.DB, EMAIL, 100);
		expect(await row()).toMatchObject({
			session_issued_at: 100,
			removed_at: null,
			count: 1,
		});
	});
});
