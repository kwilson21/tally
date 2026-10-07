import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	noteHouseholdMember,
	readBankSignInEmails,
	removeHouseholdMember,
	saveBankSignInEmails,
} from "../src/db/reconnect";
import { resetDemo } from "../src/demo/reset";
import handler from "../src/index";
import { renderReconnectEmail } from "../src/reconnect/email";
import { runReconnectReminders } from "../src/reconnect/reminders";

const BASE = "http://tally.test";
const post = async (path: string, fields: Record<string, string>) => {
	const res = await exports.default.fetch(`${BASE}${path}`, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			"HX-Request": "true",
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
};

beforeEach(async () => resetDemo(env.DB, "2026-10-07"));

const scheduledWith = handler as unknown as {
	scheduled(controller: { cron: string }, env: unknown): Promise<unknown>;
};

describe("reconnect reminder schedule", () => {
	it("routes the 10:00 Worker invocation through the Resend fetch boundary", async () => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (904, 'Chase', X'', 'dana@example.com', 'needs_attention')",
		).run();
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com')",
		).run();
		const requested: string[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			requested.push(String(input));
			return new Response("{}", { status: 200 });
		});
		vi.stubGlobal("fetch", fetcher);
		await scheduledWith.scheduled(
			{ cron: "0 10 * * *" },
			{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" },
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(requested[0]).toBe("https://api.resend.com/emails");
		vi.unstubAllGlobals();
	});

	it("sends once when broken, waits two days, repeats at three days, and stops when fixed or disconnected", async () => {
		const sent: string[] = [];
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status, last_synced_at) VALUES (901, 'Chase', X'', 'dana@example.com', 'needs_attention', '2026-10-01 10:14:00')",
		).run();
		await env.DB.prepare(
			"INSERT INTO accounts (plaid_item_id, name, mask, type, balance_cents) VALUES (901, 'Checking', '4521', 'depository', 123456)",
		).run();
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com')",
		).run();
		const production = { ...env, DEMO: "false", RESEND_API_KEY: "test-key" };
		await runReconnectReminders(
			production as never,
			async (_url, init) => {
				sent.push(String(init?.body));
				return new Response("{}", { status: 200 });
			},
			new Date("2026-10-07T13:00:00Z"),
		);
		expect(sent).toHaveLength(1);
		await runReconnectReminders(
			production as never,
			async () => {
				sent.push("unexpected");
				return new Response("{}", { status: 200 });
			},
			new Date("2026-10-09T13:00:00Z"),
		);
		expect(sent).toHaveLength(1);
		await runReconnectReminders(
			production as never,
			async (_url, init) => {
				sent.push(String(init?.body));
				return new Response("{}", { status: 200 });
			},
			new Date("2026-10-10T13:00:00Z"),
		);
		expect(sent).toHaveLength(2);
		await env.DB.prepare(
			"UPDATE plaid_items SET status = 'ok' WHERE id = 901",
		).run();
		await runReconnectReminders(
			production as never,
			async () => {
				sent.push("unexpected");
				return new Response("{}", { status: 200 });
			},
			new Date("2026-10-13T13:00:00Z"),
		);
		expect(sent).toHaveLength(2);
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status, disconnected_at) VALUES (902, 'Wells Fargo', X'', 'dana@example.com', 'needs_attention', '2026-10-06')",
		).run();
		await runReconnectReminders(
			production as never,
			async () => {
				sent.push("unexpected");
				return new Response("{}", { status: 200 });
			},
			new Date("2026-10-14T13:00:00Z"),
		);
		expect(sent).toHaveLength(2);
	});

	it("sends individually to recent members, falls back after a Resend failure, and skips Off and demo", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com'), ('riley@example.com')",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (903, 'Chase', X'', 'dana@example.com', 'needs_attention')",
		).run();
		const sentTo: string[] = [];
		const production = {
			...env,
			DEMO: "false",
			RESEND_API_KEY: "test-key",
			EMAIL: {
				send: async ({ to }: { to: string }) => {
					sentTo.push(to);
				},
			},
		};
		await runReconnectReminders(
			production as never,
			async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as {
					to: string[] | string;
				};
				expect(body.to).toBeTypeOf("string");
				return new Response("{}", { status: 503 });
			},
			new Date("2026-10-07T13:00:00Z"),
		);
		expect(sentTo.sort()).toEqual(["dana@example.com", "riley@example.com"]);
		await saveBankSignInEmails(env.DB, false);
		await runReconnectReminders(
			production as never,
			async () => {
				throw new Error("must not send");
			},
			new Date("2026-10-08T13:00:00Z"),
		);
		await saveBankSignInEmails(env.DB, true);
		await runReconnectReminders(
			{ ...production, DEMO: "true" } as never,
			async () => {
				throw new Error("demo must not send");
			},
			new Date("2026-10-08T13:00:00Z"),
		);
		expect(sentTo).toHaveLength(2);
	});

	it("renders names, both account endings and last sync, never balances or dollar amounts", () => {
		const email = renderReconnectEmail(
			{
				bank: "Chase",
				lastSyncedAt: "2026-10-01 10:14:00",
				accounts: [
					{ name: "Checking", mask: "4521" },
					{ name: "Savings", mask: "1180" },
				],
			},
			"America/New_York",
		);
		expect(email.subject).toBe("Chase needs you to sign in again");
		expect(email.html).toContain("Checking ••4521");
		expect(email.html).toContain("Checking, ending in 4521");
		expect(email.text).toContain("Checking, ending in 4521");
		expect(email.text).toContain("Savings, ending in 1180");
		expect(email.text).toContain("Oct 1 at 6:14 AM");
		expect(email.html).toContain("Open Accounts");
		expect(email.text).not.toMatch(/\$\s?\d/);
	});
});

describe("bank sign-in reminder Settings", () => {
	it("saves the household switch and renders Off afterwards", async () => {
		const { html } = await post("/settings/bank-sign-in-emails", {});
		expect(await readBankSignInEmails(env.DB)).toBe(false);
		const reminders =
			html.split('id="reminders"')[1]?.split("</section>")[0] ?? "";
		expect(reminders).toContain(">Off<");
		expect(reminders).not.toMatch(/id="bank-sign-in-emails"[^>]*checked/);
	});

	it("keeps a removed address hidden until a newer verified Access session", async () => {
		await noteHouseholdMember(env.DB, "dana@example.com", 100);
		await removeHouseholdMember(env.DB, "dana@example.com");
		await noteHouseholdMember(env.DB, "dana@example.com", 100);
		let row = await env.DB.prepare(
			"SELECT removed_at FROM household_members WHERE email = ?",
		)
			.bind("dana@example.com")
			.first<{ removed_at: string | null }>();
		expect(row?.removed_at).not.toBeNull();
		await noteHouseholdMember(env.DB, "dana@example.com", 101);
		row = await env.DB.prepare(
			"SELECT removed_at FROM household_members WHERE email = ?",
		)
			.bind("dana@example.com")
			.first<{ removed_at: string | null }>();
		expect(row?.removed_at).toBeNull();
	});

	it("keeps the reminder pass below D1's 1,000 statement invocation limit", async () => {
		await env.DB.batch(
			Array.from({ length: 100 }, (_, i) =>
				env.DB.prepare(
					"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (?, ?, X'', 'dana@example.com', 'needs_attention')",
				).bind(1000 + i, `Bank ${i}`),
			),
		);
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com')",
		).run();
		let statements = 0;
		const db = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						statements += 1;
						return target.prepare(sql);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await runReconnectReminders(
			{ DB: db, DEMO: "false", RESEND_API_KEY: "test-key" },
			async () => new Response("{}"),
			new Date("2026-10-07T13:00:00Z"),
		);
		expect(statements).toBeLessThan(1000);
	});
});
