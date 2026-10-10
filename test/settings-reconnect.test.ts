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
	it("uses household local dates for the three day cadence across UTC boundaries and DST", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com')",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status, reconnect_emailed_at) VALUES (905, 'Chase', X'', 'dana@example.com', 'needs_attention', '2026-03-07 04:30:00')",
		).run();
		const sent: string[] = [];
		const sendAt = async (date: string) =>
			runReconnectReminders(
				{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" } as never,
				async () => {
					sent.push(date);
					return new Response("{}");
				},
				new Date(date),
			);
		await sendAt("2026-03-09T13:00:00Z"); // Mar 6 23:30 EST to Mar 9 09:00 EDT: three local dates.
		expect(sent).toHaveLength(1);
		await env.DB.prepare(
			"UPDATE plaid_items SET reconnect_emailed_at = '2026-10-30 04:00:00' WHERE id = 905",
		).run();
		await sendAt("2026-11-01T13:00:00Z"); // Two local dates across the fall-back boundary.
		expect(sent).toHaveLength(1);
		await sendAt("2026-11-02T13:00:00Z");
		expect(sent).toHaveLength(2);
	});

	it("claims before sending so a failed claim cannot cause duplicate mail, and releases a wholly failed claim", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com')",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (906, 'Chase', X'', 'dana@example.com', 'needs_attention')",
		).run();
		let failClaim = true;
		const db = new Proxy(env.DB, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property === "prepare")
					return (sql: string) => {
						const statement = target.prepare(sql);
						if (sql.startsWith("UPDATE plaid_items SET reconnect_emailed_at"))
							return new Proxy(statement, {
								get(inner, key) {
									if (key === "bind")
										return (...args: unknown[]) =>
											new Proxy(inner.bind(...args), {
												get(bound, method) {
													if (method === "run")
														return async () => {
															if (failClaim) {
																failClaim = false;
																throw new Error("D1 unavailable");
															}
															return bound.run();
														};
													const result = Reflect.get(bound, method);
													return typeof result === "function"
														? result.bind(bound)
														: result;
												},
											});
									const result = Reflect.get(inner, key);
									return typeof result === "function"
										? result.bind(inner)
										: result;
								},
							});
						return statement;
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const sends: string[] = [];
		const production = { DB: db, DEMO: "false", RESEND_API_KEY: "test-key" };
		await expect(
			runReconnectReminders(
				production as never,
				async () => {
					sends.push("first");
					return new Response("{}");
				},
				new Date("2026-10-07T13:00:00Z"),
			),
		).rejects.toThrow();
		await runReconnectReminders(
			production as never,
			async () => {
				sends.push("second");
				return new Response("{}");
			},
			new Date("2026-10-08T13:00:00Z"),
		);
		expect(sends).toEqual(["second"]);
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (909, 'Wells Fargo', X'', 'dana@example.com', 'needs_attention')",
		).run();
		await runReconnectReminders(
			{
				...production,
				DB: env.DB,
				EMAIL: {
					send: async () => {
						throw new Error("fallback unavailable");
					},
				},
			} as never,
			async () => new Response("failed", { status: 503 }),
			new Date("2026-10-09T13:00:00Z"),
		);
		const row = await env.DB.prepare(
			"SELECT reconnect_emailed_at FROM plaid_items WHERE id = 909",
		).first<{ reconnect_emailed_at: string | null }>();
		expect(row?.reconnect_emailed_at).toBeNull();
	});
	it("routes the 10:00 Worker invocation through the Resend fetch boundary", async () => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (904, 'Chase', X'', 'dana@example.com', 'needs_attention')",
		).run();
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com')",
		).run();
		const requested: string[] = [];
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requested.push(String(input));
				if (init)
					expect(JSON.parse(String(init.body)).from).toBe(
						"Tally <tally@notifs.thesuperhuman.us>",
					);
				return new Response("{}", { status: 200 });
			},
		);
		vi.stubGlobal("fetch", fetcher);
		await scheduledWith.scheduled(
			{ cron: "0 10 * * *" },
			{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" },
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(requested[0]).toBe("https://api.resend.com/emails");
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).from).toBe(
			"Tally <tally@notifs.thesuperhuman.us>",
		);
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

	it("keeps a partial delivery claim and retries every recipient on the next three day pass", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com'), ('riley@example.com')",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (910, 'Chase', X'', 'dana@example.com', 'needs_attention')",
		).run();
		const attempted: string[] = [];
		const production = {
			...env,
			DEMO: "false",
			RESEND_API_KEY: "test-key",
			EMAIL: {
				send: async ({ to, from }: { to: string; from: string }) => {
					attempted.push(`fallback:${to}`);
					expect(from).toBe("Tally <tally@notifs.thesuperhuman.us>");
					if (to === "riley@example.com")
						throw new Error("fallback unavailable");
				},
			},
		};
		const sendAt = (date: string) =>
			runReconnectReminders(
				production as never,
				async (_url, init) => {
					const body = JSON.parse(String(init?.body)) as { to: string };
					attempted.push(`resend:${body.to}`);
					return new Response("failed", {
						status: body.to === "riley@example.com" ? 503 : 200,
					});
				},
				new Date(date),
			);
		await sendAt("2026-10-07T13:00:00Z");
		const claim = await env.DB.prepare(
			"SELECT reconnect_emailed_at FROM plaid_items WHERE id = 910",
		).first<{ reconnect_emailed_at: string | null }>();
		expect(claim?.reconnect_emailed_at).not.toBeNull();
		expect(attempted).toEqual([
			"resend:dana@example.com",
			"resend:riley@example.com",
			"fallback:riley@example.com",
		]);
		await sendAt("2026-10-08T13:00:00Z");
		await sendAt("2026-10-09T13:00:00Z");
		expect(attempted).toHaveLength(3);
		await sendAt("2026-10-10T13:00:00Z");
		expect(attempted.slice(3)).toEqual([
			"resend:dana@example.com",
			"resend:riley@example.com",
			"fallback:riley@example.com",
		]);
	});

	it("times out stalled Resend, falls back, releases a failed claim, and logs no address", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('dana@example.com')",
		).run();
		await env.DB.prepare(
			"UPDATE household_settings SET value = 'on' WHERE key = 'bank_sign_in_emails'",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (911, 'Chase', X'', 'dana@example.com', 'needs_attention')",
		).run();
		const fallback = vi.fn();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const stalledFetch = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{
							once: true,
						},
					);
				}),
		);
		await runReconnectReminders(
			{
				...env,
				DEMO: "false",
				RESEND_API_KEY: "test-key",
				EMAIL: { send: fallback },
			} as never,
			stalledFetch,
			new Date("2026-10-07T13:00:00Z"),
			() => AbortSignal.timeout(10),
		);
		expect(stalledFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
		expect(fallback).toHaveBeenCalledOnce();
		const claim = await env.DB.prepare(
			"SELECT reconnect_emailed_at FROM plaid_items WHERE id = 911",
		).first<{ reconnect_emailed_at: string | null }>();
		expect(claim?.reconnect_emailed_at).toBe("2026-10-07 13:00:00");
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toContain(
			"reconnect reminders: 1 sent, 0 banks failed (ok)",
		);
		expect(log.mock.calls[0]?.[0]).not.toContain("dana@example.com");
		log.mockRestore();
	});

	it("logs provider failures without recipient addresses and releases the claim", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email) VALUES ('private@example.com')",
		).run();
		await env.DB.prepare(
			"UPDATE household_settings SET value = 'on' WHERE key = 'bank_sign_in_emails'",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (912, 'Chase', X'', 'private@example.com', 'needs_attention')",
		).run();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runReconnectReminders(
			{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" } as never,
			async () => new Response("{}", { status: 422 }),
			new Date("2026-10-07T13:00:00Z"),
			() => AbortSignal.timeout(10),
		);
		const claim = await env.DB.prepare(
			"SELECT reconnect_emailed_at FROM plaid_items WHERE id = 912",
		).first<{ reconnect_emailed_at: string | null }>();
		expect(claim?.reconnect_emailed_at).toBeNull();
		expect(log.mock.calls[0]?.[0]).toContain(
			"1 recipients failed (resend 422)",
		);
		expect(log.mock.calls[0]?.[0]).not.toContain("private@example.com");
		log.mockRestore();
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
	it("shows and emails only members seen within the last 90 days", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email, last_seen_at) VALUES ('old@example.com', datetime('now', '-91 days')), ('recent@example.com', datetime('now', '-89 days'))",
		).run();
		const response = await exports.default.fetch(`${BASE}/settings`);
		const settingsHtml = await response.text();
		const reminders =
			settingsHtml.split('id="reminders"')[1]?.split("</section>")[0] ?? "";
		expect(reminders).toContain("recent@example.com");
		expect(reminders).not.toContain("old@example.com");
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (911, 'Chase', X'', 'recent@example.com', 'needs_attention')",
		).run();
		const sent: string[] = [];
		await runReconnectReminders(
			{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" } as never,
			async (_url, init) => {
				sent.push(JSON.parse(String(init?.body)).to);
				return new Response("{}");
			},
			new Date(),
		);
		expect(sent).toEqual(["recent@example.com"]);
	});

	it("saves the household switch and renders Off afterwards", async () => {
		const { html } = await post("/settings/bank-sign-in-emails", {});
		expect(await readBankSignInEmails(env.DB)).toBe(false);
		const reminders =
			html.split('id="reminders"')[1]?.split("</section>")[0] ?? "";
		expect(reminders).toContain(">Off<");
		expect(reminders).toContain('open=""');
		expect(reminders).toContain('autofocus=""');
		expect(reminders).not.toMatch(/id="bank-sign-in-emails"[^>]*checked/);
	});

	it("keeps the address disclosure open and focuses the next Remove or its summary", async () => {
		await noteHouseholdMember(env.DB, "dana@example.com", 100);
		await noteHouseholdMember(env.DB, "riley@example.com", 100);
		const removed = await post("/settings/household-members/remove", {
			email: "dana@example.com",
		});
		const reminders =
			removed.html.split('id="reminders"')[1]?.split("</section>")[0] ?? "";
		expect(reminders).toContain('open=""');
		expect(reminders).toContain(
			'aria-label="Remove riley@example.com" autofocus=""',
		);

		const last = await post("/settings/household-members/remove", {
			email: "riley@example.com",
		});
		const emptyReminders =
			last.html.split('id="reminders"')[1]?.split("</section>")[0] ?? "";
		expect(emptyReminders).toContain('open=""');
		expect(emptyReminders).toContain(
			'<summary class="flex min-h-11 cursor-pointer items-center" autofocus="">',
		);
	});

	it("restores a removed address only for a session issued after removal", async () => {
		await noteHouseholdMember(env.DB, "dana@example.com", 100);
		await removeHouseholdMember(env.DB, "dana@example.com");
		await noteHouseholdMember(env.DB, "dana@example.com", 100);
		let row = await env.DB.prepare(
			"SELECT removed_at FROM household_members WHERE email = ?",
		)
			.bind("dana@example.com")
			.first<{ removed_at: string | null }>();
		expect(row?.removed_at).not.toBeNull();
		await noteHouseholdMember(
			env.DB,
			"dana@example.com",
			Math.floor(Date.now() / 1000) - 1,
		);
		row = await env.DB.prepare(
			"SELECT removed_at FROM household_members WHERE email = ?",
		)
			.bind("dana@example.com")
			.first<{ removed_at: string | null }>();
		expect(row?.removed_at).not.toBeNull();
		await noteHouseholdMember(
			env.DB,
			"dana@example.com",
			Math.floor(Date.now() / 1000) + 1,
		);
		row = await env.DB.prepare(
			"SELECT removed_at FROM household_members WHERE email = ?",
		)
			.bind("dana@example.com")
			.first<{ removed_at: string | null }>();
		expect(row?.removed_at).toBeNull();
	});

	it("Remove hides a known address and announces invalid and unknown address errors", async () => {
		await noteHouseholdMember(env.DB, "dana@example.com", 100);
		const removed = await post("/settings/household-members/remove", {
			email: "dana@example.com",
		});
		expect(removed.res.status).toBe(200);
		const unknown = await post("/settings/household-members/remove", {
			email: "missing@example.com",
		});
		expect(unknown.res.status).toBe(404);
		for (const [response, message, status] of [
			[unknown, "Address not found.", 404],
			[
				await post("/settings/household-members/remove", { email: "bad" }),
				"Choose an address to remove.",
				400,
			],
		] as const) {
			expect(response.res.status).toBe(status);
			expect(response.html).toContain('role="alert"');
			expect(
				JSON.parse(response.res.headers.get("HX-Trigger") ?? "{}"),
			).toMatchObject({ toast: { message, type: "error" }, announce: message });
			expect(response.html).toContain(message);
			expect(
				JSON.parse(response.res.headers.get("HX-Trigger") ?? "{}").announce,
			).toContain(message);
		}
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (907, 'Chase', X'', 'dana@example.com', 'needs_attention')",
		).run();
		const sent: string[] = [];
		await runReconnectReminders(
			{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" } as never,
			async (_url, init) => {
				sent.push(String(init?.body));
				return new Response("{}");
			},
			new Date("2026-10-07T13:00:00Z"),
		);
		expect(sent).toHaveLength(0);
	});

	it("does not email members whose last sign-in was over 90 days ago", async () => {
		await env.DB.prepare(
			"INSERT INTO household_members (email, last_seen_at) VALUES ('old@example.com', '2026-07-08 12:59:59')",
		).run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (id, institution_name, access_token_encrypted, linked_by, status) VALUES (908, 'Chase', X'', 'old@example.com', 'needs_attention')",
		).run();
		const sent: string[] = [];
		await runReconnectReminders(
			{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" } as never,
			async (_url, init) => {
				sent.push(String(init?.body));
				return new Response("{}");
			},
			new Date("2026-10-07T13:00:00Z"),
		);
		expect(sent).toHaveLength(0);
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
