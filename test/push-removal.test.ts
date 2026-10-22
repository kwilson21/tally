import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { removeHouseholdMember } from "../src/db/reconnect";

// A removed person's devices go with them (decision 148): their push subscriptions are deleted in the same run as the removal,
// and nobody else's are touched.

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM push_subscriptions"),
		env.DB.prepare("DELETE FROM household_members"),
	]);
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO household_members (email, last_seen_at) VALUES ('dana@example.com', datetime('now')), ('riley@example.com', datetime('now'))",
		),
		env.DB.prepare(
			"INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth) VALUES ('dana@example.com', 'https://push.example.test/dana-phone', 'k1', 'a1'), ('dana@example.com', 'https://push.example.test/dana-laptop', 'k2', 'a2'), ('riley@example.com', 'https://push.example.test/riley-phone', 'k3', 'a3')",
		),
	]);
});

describe("removing a person", () => {
	it("deletes that person's push subscriptions and leaves everyone else's", async () => {
		await removeHouseholdMember(env.DB, "dana@example.com");
		const { results } = await env.DB.prepare(
			"SELECT member_email FROM push_subscriptions ORDER BY id",
		).all<{ member_email: string }>();
		expect(results).toEqual([{ member_email: "riley@example.com" }]);
		const member = await env.DB.prepare(
			"SELECT removed_at FROM household_members WHERE email = 'dana@example.com'",
		).first<{ removed_at: string | null }>();
		expect(member?.removed_at).not.toBeNull();
	});

	it("deletes no push subscription when the address is not a member", async () => {
		await removeHouseholdMember(env.DB, "nobody@example.com");
		const row = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM push_subscriptions",
		).first<{ n: number }>();
		expect(row?.n).toBe(3);
	});
});
