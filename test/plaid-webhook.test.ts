import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_SWITCHES_ALL_ON, saveAiSwitches } from "../src/db/ai-switches";
import { app } from "../src/index";
import { encryptToken } from "../src/plaid/token-crypto";

const KEY = btoa("01234567890123456789012345678901");
const encoder = new TextEncoder();
const b64 = (value: Uint8Array) =>
	btoa(String.fromCharCode(...value))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
const json64 = (value: unknown) => b64(encoder.encode(JSON.stringify(value)));

async function signer() {
	const pair = (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const kid = crypto.randomUUID();
	return async (body: string) => {
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", encoder.encode(body)),
		);
		const signed = `${json64({ alg: "ES256", kid })}.${json64({
			iat: Math.floor(Date.now() / 1000),
			request_body_sha256: Array.from(digest, (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join(""),
		})}`;
		const signature = new Uint8Array(
			await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				pair.privateKey,
				encoder.encode(signed),
			),
		);
		return {
			token: `${signed}.${b64(signature)}`,
			jwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
		};
	};
}

describe("Plaid webhook route", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
		await saveAiSwitches(env.DB, { details: false });
		Object.assign(env, {
			DEMO: "false",
			PLAID_CLIENT_ID: "client",
			PLAID_SECRET: "secret",
			PLAID_ENV: "sandbox",
			TOKEN_ENCRYPTION_KEY: KEY,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([{ DEMO: "true" }, { PLAID_SECRET: undefined }])(
		"returns 404 when Plaid is not enabled: %o",
		async (disabled) => {
			Object.assign(env, disabled);
			expect(
				(
					await app.request(
						"/webhooks/plaid",
						{ method: "POST", headers: { "content-type": "application/json" } },
						env,
					)
				).status,
			).toBe(404);
		},
	);

	it("rejects a bad signature before writing", async () => {
		const prepare = vi.spyOn(env.DB, "prepare");
		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{
				method: "POST",
				body: "{}",
				headers: {
					"content-type": "application/json",
					"Plaid-Verification": "bad",
				},
			},
			env,
		);
		expect(response.status).toBe(401);
		expect(prepare).not.toHaveBeenCalled();
	});

	it("returns 503 when Plaid's key service is unavailable", async () => {
		const sign = await signer();
		const body = "{}";
		const { token } = await sign(body);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 500 })),
		);
		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"Plaid-Verification": token,
				},
			},
			env,
		);
		expect(response.status).toBe(503);
	});

	it("accepts signed JSON without an Origin and ignores an unknown Item", async () => {
		const sign = await signer();
		const body = JSON.stringify({
			item_id: "unknown",
			webhook_type: "ITEM",
			webhook_code: "ERROR",
		});
		const { token, jwk } = await sign(body);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ key: { ...jwk, expired_at: null } })),
		);
		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"Plaid-Verification": token,
				},
			},
			env,
		);
		expect(response.status).toBe(200);
	});

	it("returns 400 only after a signed body fails JSON parsing", async () => {
		const sign = await signer();
		const body = "not JSON";
		const { token, jwk } = await sign(body);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ key: { ...jwk, expired_at: null } })),
		);
		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"Plaid-Verification": token,
				},
			},
			env,
		);
		expect(response.status).toBe(400);
	});

	it.each(["null", "[]"])(
		"ignores a signed non-object body: %s",
		async (body) => {
			const prepare = vi.spyOn(env.DB, "prepare");
			const sign = await signer();
			const { token, jwk } = await sign(body);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({ key: { ...jwk, expired_at: null } })),
			);
			const response = await app.request(
				"http://tally.test/webhooks/plaid",
				{
					method: "POST",
					body,
					headers: {
						"content-type": "application/json",
						"Plaid-Verification": token,
					},
				},
				env,
			);
			expect(response.status).toBe(200);
			expect(prepare).not.toHaveBeenCalled();
		},
	);

	it.each([
		["ERROR", "PRODUCT_NOT_READY", "ok"],
		["PENDING_EXPIRATION", undefined, "needs_attention"],
		["PENDING_DISCONNECT", undefined, "needs_attention"],
		["USER_PERMISSION_REVOKED", undefined, "needs_attention"],
	] as const)("handles ITEM %s", async (webhookCode, errorCode, status) => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by) VALUES ('item-1', ?, 'Bank', 'person')",
		)
			.bind(await encryptToken("access-token", KEY))
			.run();
		const sign = await signer();
		const body = JSON.stringify({
			item_id: "item-1",
			webhook_type: "ITEM",
			webhook_code: webhookCode,
			...(errorCode !== undefined ? { error: { error_code: errorCode } } : {}),
		});
		const { token, jwk } = await sign(body);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ key: { ...jwk, expired_at: null } })),
		);
		expect(
			(
				await app.request(
					"http://tally.test/webhooks/plaid",
					{
						method: "POST",
						body,
						headers: {
							"content-type": "application/json",
							"Plaid-Verification": token,
						},
					},
					env,
				)
			).status,
		).toBe(200);
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items").first(),
		).toEqual({ status });
		if (webhookCode !== "ERROR") {
			expect(fetch).toHaveBeenCalledTimes(1);
		}
	});

	it.each([
		["ITEM_LOGIN_REQUIRED", null, "ok"],
		[
			"ITEM_LOGIN_REQUIRED",
			{ error_code: "ITEM_LOGIN_REQUIRED" },
			"needs_attention",
		],
		[undefined, { error_code: "ITEM_LOGIN_REQUIRED" }, "needs_attention"],
		[null, { error_code: "ITEM_LOGIN_REQUIRED" }, "needs_attention"],
	] as const)(
		"confirms an ITEM error with Plaid before setting status: webhook error %o, current error %o",
		async (webhookError, currentError, status) => {
			await env.DB.prepare(
				"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by) VALUES ('item-1', ?, 'Bank', 'person')",
			)
				.bind(await encryptToken("access-token", KEY))
				.run();
			const sign = await signer();
			const body = JSON.stringify({
				item_id: "item-1",
				webhook_type: "ITEM",
				webhook_code: "ERROR",
				...(webhookError !== undefined
					? { error: { error_code: webhookError } }
					: {}),
			});
			const { token, jwk } = await sign(body);
			const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith("/webhook_verification_key/get")
					? Response.json({ key: { ...jwk, expired_at: null } })
					: Response.json({ item: { error: currentError } }),
			);
			vi.stubGlobal("fetch", fetchMock);
			const promises: Promise<unknown>[] = [];
			const ctx = {
				waitUntil: (promise: Promise<unknown>) => promises.push(promise),
				passThroughOnException() {},
				props: {},
			} as unknown as ExecutionContext;
			expect(
				(
					await app.request(
						"http://tally.test/webhooks/plaid",
						{
							method: "POST",
							body,
							headers: {
								"content-type": "application/json",
								"Plaid-Verification": token,
							},
						},
						env,
						ctx,
					)
				).status,
			).toBe(200);
			expect(promises).toHaveLength(1);
			await Promise.all(promises);
			expect(
				await env.DB.prepare("SELECT status FROM plaid_items").first(),
			).toEqual({ status });
			expect(
				fetchMock.mock.calls.filter(([input]) =>
					String(input).endsWith("/item/get"),
				),
			).toHaveLength(1);
		},
	);

	it("doesn't overwrite a repair completed while confirming an ITEM error", async () => {
		const encryptedToken = await encryptToken("access-token", KEY);
		await env.DB.prepare(
			"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by, status) VALUES ('item-1', ?, 'Bank', 'person', 'needs_attention')",
		)
			.bind(encryptedToken)
			.run();
		const sign = await signer();
		const body = JSON.stringify({
			item_id: "item-1",
			webhook_type: "ITEM",
			webhook_code: "ERROR",
			error: { error_code: "ITEM_LOGIN_REQUIRED" },
		});
		const { token, jwk } = await sign(body);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).endsWith("/webhook_verification_key/get")) {
					return Response.json({ key: { ...jwk, expired_at: null } });
				}
				await env.DB.prepare("UPDATE plaid_items SET status = 'ok'").run();
				return Response.json({
					item: { error: { error_code: "ITEM_LOGIN_REQUIRED" } },
				});
			}),
		);
		const promises: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => promises.push(promise),
			passThroughOnException() {},
			props: {},
		} as unknown as ExecutionContext;

		expect(
			(
				await app.request(
					"http://tally.test/webhooks/plaid",
					{
						method: "POST",
						body,
						headers: {
							"content-type": "application/json",
							"Plaid-Verification": token,
						},
					},
					env,
					ctx,
				)
			).status,
		).toBe(200);
		await Promise.all(promises);
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items").first(),
		).toEqual({ status: "ok" });
	});

	it("syncs the matching Item in waitUntil without logging secrets", async () => {
		await env.DB.prepare(
			"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by) VALUES ('item-secret', ?, 'Bank', 'person')",
		)
			.bind(await encryptToken("token-secret", KEY))
			.run();
		const sign = await signer();
		const body = JSON.stringify({
			item_id: "item-secret",
			webhook_type: "TRANSACTIONS",
			webhook_code: "SYNC_UPDATES_AVAILABLE",
		});
		const { token, jwk } = await sign(body);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/webhook_verification_key/get"))
				return Response.json({ key: { ...jwk, expired_at: null } });
			if (url.endsWith("/accounts/get"))
				return Response.json({
					accounts: [
						{
							account_id: "account-1",
							name: "Checking",
							type: "depository",
							balances: { current: 10 },
						},
					],
				});
			return Response.json({
				added: [
					{
						transaction_id: "tx-1",
						account_id: "account-1",
						date: "2026-09-27",
						amount: 4.25,
						name: "SHOP",
						pending: false,
					},
				],
				modified: [],
				removed: [],
				next_cursor: "next",
				has_more: false,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const promises: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => promises.push(promise),
			passThroughOnException() {},
			props: {},
		} as unknown as ExecutionContext;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"Plaid-Verification": token,
				},
			},
			env,
			ctx,
		);
		expect(response.status).toBe(200);
		await Promise.all(promises);
		expect(
			await env.DB.prepare(
				"SELECT plaid_transaction_id FROM transactions",
			).first(),
		).toEqual({ plaid_transaction_id: "tx-1" });
		const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
		expect(output).not.toContain("item-secret");
		expect(output).not.toContain("token-secret");
		expect(output).not.toContain(token);
	});

	it("applies a merchant rule to the new transactions a webhook sync brings in", async () => {
		const category = await env.DB.prepare(
			"SELECT id FROM categories WHERE archived = 0 ORDER BY sort_order LIMIT 1",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO merchants (raw_name, default_category_id) VALUES ('RULED SHOP', ?)",
		)
			.bind(category?.id)
			.run();
		await env.DB.prepare(
			"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by) VALUES ('item-rules', ?, 'Bank', 'person')",
		)
			.bind(await encryptToken("token-rules", KEY))
			.run();
		const sign = await signer();
		const body = JSON.stringify({
			item_id: "item-rules",
			webhook_type: "TRANSACTIONS",
			webhook_code: "SYNC_UPDATES_AVAILABLE",
		});
		const { token, jwk } = await sign(body);
		const added = (id: string, name: string) => ({
			transaction_id: id,
			account_id: "account-1",
			date: "2026-09-27",
			amount: 4.25,
			name,
			pending: false,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/webhook_verification_key/get"))
					return Response.json({ key: { ...jwk, expired_at: null } });
				if (url.endsWith("/accounts/get"))
					return Response.json({
						accounts: [
							{
								account_id: "account-1",
								name: "Checking",
								type: "depository",
								balances: { current: 10 },
							},
						],
					});
				return Response.json({
					added: [
						added("ruled", "RULED SHOP"),
						added("unruled", "UNKNOWN SHOP"),
					],
					modified: [],
					removed: [],
					next_cursor: "next",
					has_more: false,
				});
			}),
		);
		const promises: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => promises.push(promise),
			passThroughOnException() {},
			props: {},
		} as unknown as ExecutionContext;
		vi.spyOn(console, "log").mockImplementation(() => {});

		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"Plaid-Verification": token,
				},
			},
			env,
			ctx,
		);
		expect(response.status).toBe(200);
		await Promise.all(promises);

		expect(
			(
				await env.DB.prepare(
					"SELECT plaid_transaction_id AS id, category_id, category_source FROM transactions ORDER BY id",
				).all()
			).results,
		).toEqual([
			{
				id: "ruled",
				category_id: category?.id,
				category_source: "merchant_rule",
			},
			{ id: "unruled", category_id: null, category_source: null },
		]);
	});
});

// Spec §8.6, decision 68: after a webhook's sync, in the same waitUntil, Jev sorts what arrived.
describe("Plaid webhook sorting what arrived", () => {
	const JEV_URL = "https://api.typesafe.ai/v1/systemone";
	const jevSays = () =>
		Response.json({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence: 0.95 },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		});

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchants"),
			env.DB.prepare("DELETE FROM household_settings WHERE key != 'time_zone'"),
		]);
		await saveAiSwitches(env.DB, { details: false });
		Object.assign(env, {
			DEMO: "false",
			PLAID_CLIENT_ID: "client",
			PLAID_SECRET: "secret",
			PLAID_ENV: "sandbox",
			TOKEN_ENCRYPTION_KEY: KEY,
			JEV_API_KEY: "jev-key",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		Object.assign(env, { JEV_API_KEY: undefined });
	});

	/** Delivers a signed webhook for a bank whose sync brings in one transaction, "NEW SHOP". */
	async function deliver(jev: () => Response = jevSays) {
		await env.DB.prepare(
			"INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by) VALUES ('item-sort', ?, 'Bank', 'person')",
		)
			.bind(await encryptToken("token-sort", KEY))
			.run();
		const sign = await signer();
		const body = JSON.stringify({
			item_id: "item-sort",
			webhook_type: "TRANSACTIONS",
			webhook_code: "SYNC_UPDATES_AVAILABLE",
		});
		const { token, jwk } = await sign(body);
		const asked: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === JEV_URL) {
					asked.push(JSON.parse(String(init?.body)).state.bank_description);
					return jev();
				}
				if (url.endsWith("/webhook_verification_key/get"))
					return Response.json({ key: { ...jwk, expired_at: null } });
				if (url.endsWith("/accounts/get"))
					return Response.json({
						accounts: [
							{
								account_id: "account-1",
								name: "Checking",
								type: "depository",
								balances: { current: 10 },
							},
						],
					});
				return Response.json({
					added: [
						{
							transaction_id: "tx-new",
							account_id: "account-1",
							date: "2026-09-27",
							amount: 4.25,
							name: "NEW SHOP",
							pending: false,
						},
					],
					modified: [],
					removed: [],
					next_cursor: "next",
					has_more: false,
				});
			}),
		);
		const promises: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => promises.push(promise),
			passThroughOnException() {},
			props: {},
		} as unknown as ExecutionContext;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"Plaid-Verification": token,
				},
			},
			env,
			ctx,
		);
		return {
			response,
			asked,
			finished: () => Promise.all(promises),
			logged: () => JSON.stringify([...log.mock.calls, ...error.mock.calls]),
		};
	}

	const stored = () =>
		env.DB.prepare(
			"SELECT plaid_transaction_id AS id, category_source, category_confidence FROM transactions",
		).all();

	it("asks Jev about the transactions the sync brought in, in the same waitUntil", async () => {
		const sent = await deliver();
		expect(sent.response.status).toBe(200);
		await sent.finished();
		expect(sent.asked).toEqual(["NEW SHOP"]);
		expect((await stored()).results).toEqual([
			{ id: "tx-new", category_source: "jev", category_confidence: 0.95 },
		]);
	});

	it("leaves them for the nightly run when the sorting switch is off", async () => {
		await saveAiSwitches(env.DB, { sortOnArrival: false });
		const sent = await deliver();
		await sent.finished();
		expect(sent.asked).toEqual([]);
		expect((await stored()).results).toEqual([
			{ id: "tx-new", category_source: null, category_confidence: null },
		]);
		await saveAiSwitches(env.DB, AI_SWITCHES_ALL_ON);
	});

	it("still answers 200 and keeps the sync when Jev is down, logging no names or keys", async () => {
		const sent = await deliver(() => new Response("{}", { status: 503 }));
		expect(sent.response.status).toBe(200);
		await sent.finished();
		expect(sent.asked).toEqual(["NEW SHOP"]);
		expect((await stored()).results).toEqual([
			{ id: "tx-new", category_source: null, category_confidence: null },
		]);
		const output = sent.logged();
		expect(output).toContain("jev: 503");
		for (const secret of ["NEW SHOP", "jev-key", "token-sort", "item-sort"])
			expect(output).not.toContain(secret);
	});
});
