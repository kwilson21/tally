import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "../src/plaid/token-crypto";
import { plaid } from "../src/routes/plaid";

const BASE = "http://tally.test";
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const encoder = new TextEncoder();
const encode = (value: unknown) =>
	btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

let identityNumber = 0;
async function accessIdentity() {
	identityNumber += 1;
	const team = `plaid-route-${identityNumber}.cloudflareaccess.com`;
	Object.assign(env, { ACCESS_TEAM_DOMAIN: team });
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const header = encode({ alg: "RS256", kid: "plaid-route-key" });
	const claims = encode({
		aud: ["plaid-aud"],
		iss: `https://${team}`,
		exp: Math.floor(Date.now() / 1000) + 300,
		email: "Family.Member@Example.com",
	});
	const signed = `${header}.${claims}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			pair.privateKey,
			encoder.encode(signed),
		),
	);
	return {
		jwt: `${signed}.${btoa(String.fromCharCode(...signature))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "")}`,
		jwk: {
			...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
			kid: "plaid-route-key",
		},
	};
}

async function post(path: string, jwt?: string, body = "") {
	return exports.default.fetch(BASE + path, {
		method: "POST",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
		},
		body,
	});
}

describe("Plaid routes", () => {
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM plaid_items").run();
		Object.assign(env, {
			DEMO: "false",
			PLAID_CLIENT_ID: "client-id",
			PLAID_SECRET: "plaid-secret",
			PLAID_ENV: "sandbox",
			PLAID_WEBHOOK_URL: "https://tally.test/webhooks/plaid",
			TOKEN_ENCRYPTION_KEY: KEY,
			ACCESS_TEAM_DOMAIN: "plaid-route.cloudflareaccess.com",
			ACCESS_AUD: "plaid-aud",
		});
	});

	afterEach(() => {
		Object.assign(env, {
			DEMO: "true",
			PLAID_CLIENT_ID: undefined,
			PLAID_SECRET: undefined,
			PLAID_ENV: undefined,
			PLAID_WEBHOOK_URL: undefined,
			TOKEN_ENCRYPTION_KEY: undefined,
			ACCESS_TEAM_DOMAIN: undefined,
			ACCESS_AUD: undefined,
			JEV_API_KEY: undefined,
		});
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("creates an update-mode token from the decrypted item token without products or email", async () => {
		const { jwt, jwk } = await accessIdentity();
		const inserted = await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status) VALUES (?, 'First Bank', 'family.member@example.com', 'needs_attention') RETURNING id",
		)
			.bind(await encryptToken("access-private", KEY))
			.first<{ id: number }>();
		const requests: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input).includes("cloudflareaccess.com"))
					return Response.json({ keys: [jwk] });
				requests.push(
					JSON.parse(String(init?.body)) as Record<string, unknown>,
				);
				return Response.json({ link_token: "update-link" });
			},
		);

		const response = await post(`/plaid/items/${inserted?.id}/link-token`, jwt);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ link_token: "update-link" });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ access_token: "access-private" });
		expect(requests[0]).not.toHaveProperty("products");
		expect(JSON.stringify(requests[0])).not.toContain(
			"family.member@example.com",
		);
	});

	it.each(["link-token", "repaired"])(
		"returns 404 from the %s item route for invalid ids and disabled Plaid",
		async (route) => {
			const { jwt, jwk } = await accessIdentity();
			vi.stubGlobal("fetch", async () => Response.json({ keys: [jwk] }));
			for (const id of ["999999", "not-a-number"]) {
				expect((await post(`/plaid/items/${id}/${route}`, jwt)).status).toBe(
					404,
				);
			}
			Object.assign(env, { DEMO: "true" });
			expect((await post(`/plaid/items/1/${route}`, jwt)).status).toBe(404);
			Object.assign(env, { DEMO: "false", PLAID_SECRET: undefined });
			expect((await post(`/plaid/items/1/${route}`, jwt)).status).toBe(404);
		},
	);

	it.each(["link-token", "repaired"])(
		"returns 404 from the %s route for a disconnected item",
		async (route) => {
			const { jwt, jwk } = await accessIdentity();
			const item = await env.DB.prepare(
				"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, disconnected_at) VALUES (?, 'Old Bank', 'person', datetime('now')) RETURNING id",
			)
				.bind(await encryptToken("token", KEY))
				.first<{ id: number }>();
			vi.stubGlobal("fetch", async () => Response.json({ keys: [jwk] }));
			expect(
				(await post(`/plaid/items/${item?.id}/${route}`, jwt)).status,
			).toBe(404);
		},
	);

	it.each(["link-token", "repaired"])(
		"rejects a cross-site POST to the %s item route",
		async (route) => {
			const response = await exports.default.fetch(
				`${BASE}/plaid/items/1/${route}`,
				{ method: "POST", headers: { Origin: "https://evil.example" } },
			);
			expect(response.status).toBe(403);
		},
	);

	it("marks an item repaired, starts its sync, and returns only its announcement", async () => {
		const inserted = await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status) VALUES (?, 'First Bank', 'member@example.com', 'needs_attention') RETURNING id",
		)
			.bind(await encryptToken("never-return-this", KEY))
			.first<{ id: number }>();
		const waitUntil = vi.fn((promise: Promise<unknown>) => {
			void promise.catch(() => {});
		});
		vi.stubGlobal("fetch", async () =>
			Response.json({ item: { institution_id: "ins-1", error: null } }),
		);
		const response = await plaid.request(
			`http://tally.test/plaid/items/${inserted?.id}/repaired`,
			{ method: "POST", headers: { Origin: BASE } },
			env,
			{ waitUntil, passThroughOnException() {}, props: {} },
		);

		expect(response.status).toBe(204);
		expect(waitUntil).toHaveBeenCalledOnce();
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items WHERE id = ?")
				.bind(inserted?.id)
				.first(),
		).toEqual({ status: "ok" });
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Fixed First Bank.", type: "success" },
			announce: "Fixed First Bank.",
		});
		expect(JSON.stringify([...response.headers])).not.toContain(
			"never-return-this",
		);
		expect(await response.text()).not.toContain("never-return-this");
	});

	it("sorts what the repaired bank's sync brings in, in the same waitUntil (spec §8.6)", async () => {
		Object.assign(env, { JEV_API_KEY: "jev-key" });
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
		]);
		const inserted = await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status) VALUES (?, 'First Bank', 'member@example.com', 'needs_attention') RETURNING id",
		)
			.bind(await encryptToken("repaired-token", KEY))
			.first<{ id: number }>();
		const promises: Promise<unknown>[] = [];
		const asked: string[] = [];
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://api.typesafe.ai/v1/systemone") {
					asked.push(JSON.parse(String(init?.body)).state.bank_description);
					return Response.json({
						answers: {
							category: {
								type: "choice",
								choice: "Eating Out",
								confidence: 0.95,
							},
							transfer: { type: "noul", noul: 0.01 },
							reimbursement: { type: "noul", noul: 0.01 },
							income: { type: "noul", noul: 0.01 },
						},
					});
				}
				if (url.endsWith("/item/get"))
					return Response.json({ item: { institution_id: "ins-1" } });
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
							transaction_id: "tx-repaired",
							account_id: "account-1",
							date: "2026-09-27",
							amount: 4.25,
							name: "REPAIRED SHOP",
							pending: false,
						},
					],
					modified: [],
					removed: [],
					next_cursor: "next",
					has_more: false,
				});
			},
		);
		vi.spyOn(console, "log").mockImplementation(() => {});

		const response = await plaid.request(
			`http://tally.test/plaid/items/${inserted?.id}/repaired`,
			{ method: "POST", headers: { Origin: BASE } },
			env,
			{
				waitUntil: (promise: Promise<unknown>) => promises.push(promise),
				passThroughOnException() {},
				props: {},
			},
		);
		expect(response.status).toBe(204);
		await Promise.all(promises);

		try {
			expect(asked).toEqual(["REPAIRED SHOP"]);
			expect(
				await env.DB.prepare(
					"SELECT category_source FROM transactions WHERE plaid_transaction_id = 'tx-repaired'",
				).first(),
			).toEqual({ category_source: "jev" });
		} finally {
			// The sync's accounts point at the item, which the next test deletes.
			await env.DB.batch([
				env.DB.prepare("DELETE FROM transactions"),
				env.DB.prepare("DELETE FROM accounts"),
			]);
		}
	});

	it("treats an item response without an error field as healthy", async () => {
		const inserted = await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status) VALUES (?, 'First Bank', 'member@example.com', 'needs_attention') RETURNING id",
		)
			.bind(await encryptToken("healthy-private-token", KEY))
			.first<{ id: number }>();
		const waitUntil = vi.fn((promise: Promise<unknown>) => {
			void promise.catch(() => {});
		});
		vi.stubGlobal("fetch", async () =>
			Response.json({ item: { institution_id: "ins-1" } }),
		);

		const response = await plaid.request(
			`http://tally.test/plaid/items/${inserted?.id}/repaired`,
			{ method: "POST", headers: { Origin: BASE } },
			env,
			{ waitUntil, passThroughOnException() {}, props: {} },
		);

		expect(response.status).toBe(204);
		expect(waitUntil).toHaveBeenCalledOnce();
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items WHERE id = ?")
				.bind(inserted?.id)
				.first(),
		).toEqual({ status: "ok" });
	});

	it("leaves an item needing attention when Plaid still reports an error", async () => {
		const inserted = await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status) VALUES (?, 'First Bank', 'member@example.com', 'needs_attention') RETURNING id",
		)
			.bind(await encryptToken("unhealthy-private-token", KEY))
			.first<{ id: number }>();
		const waitUntil = vi.fn();
		vi.stubGlobal("fetch", async () =>
			Response.json({
				item: {
					institution_id: "ins-1",
					error: { error_code: "ITEM_LOGIN_REQUIRED" },
				},
			}),
		);

		const response = await plaid.request(
			`http://tally.test/plaid/items/${inserted?.id}/repaired`,
			{ method: "POST", headers: { Origin: BASE } },
			env,
			{ waitUntil, passThroughOnException() {}, props: {} },
		);

		expect(response.status).toBe(502);
		expect(await response.text()).toContain(
			"Couldn&#39;t fix the connection. Try again.",
		);
		expect(waitUntil).not.toHaveBeenCalled();
		expect(
			await env.DB.prepare("SELECT status FROM plaid_items WHERE id = ?")
				.bind(inserted?.id)
				.first(),
		).toEqual({ status: "needs_attention" });
	});

	it("handles a Plaid item lookup failure without exposing the token", async () => {
		const inserted = await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, status) VALUES (?, 'First Bank', 'member@example.com', 'needs_attention') RETURNING id",
		)
			.bind(await encryptToken("never-log-or-return-this", KEY))
			.first<{ id: number }>();
		const waitUntil = vi.fn();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", async () =>
			Response.json(
				{ error_code: "ITEM_LOGIN_REQUIRED", request_id: "req-repair" },
				{ status: 400 },
			),
		);

		const response = await plaid.request(
			`http://tally.test/plaid/items/${inserted?.id}/repaired`,
			{ method: "POST", headers: { Origin: BASE } },
			env,
			{ waitUntil, passThroughOnException() {}, props: {} },
		);
		const body = await response.text();

		expect(response.status).toBe(502);
		expect(body).toContain("Couldn&#39;t fix the connection. Try again.");
		expect(waitUntil).not.toHaveBeenCalled();
		expect(errors).toHaveBeenCalledWith("Plaid request failed", {
			request_id: "req-repair",
		});
		expect(JSON.stringify(errors.mock.calls)).not.toContain(
			"never-log-or-return-this",
		);
		expect(JSON.stringify([...response.headers]) + body).not.toContain(
			"never-log-or-return-this",
		);
	});

	it("shows a generic update-token failure and never logs its token", async () => {
		const { jwt, jwk } = await accessIdentity();
		const inserted = await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by) VALUES (?, 'First Bank', 'member@example.com') RETURNING id",
		)
			.bind(await encryptToken("never-log-update-token", KEY))
			.first<{ id: number }>();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", async (input: string | URL | Request) =>
			String(input).includes("cloudflareaccess.com")
				? Response.json({ keys: [jwk] })
				: Response.json(
						{ error_code: "BAD", request_id: "req-update" },
						{ status: 400 },
					),
		);

		const response = await post(`/plaid/items/${inserted?.id}/link-token`, jwt);
		expect(response.status).toBe(502);
		expect(await response.text()).toContain(
			"Couldn&#39;t fix the connection. Try again.",
		);
		expect(errors).toHaveBeenCalledWith("Plaid request failed", {
			request_id: "req-update",
		});
		expect(JSON.stringify(errors.mock.calls)).not.toContain(
			"never-log-update-token",
		);
	});

	it("creates a Link token with a stable non-email user id", async () => {
		const { jwt, jwk } = await accessIdentity();
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("cloudflareaccess.com"))
					return Response.json({ keys: [jwk] });
				requests.push({
					url,
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return Response.json({ link_token: "link-value" });
			},
		);
		const response = await post("/plaid/link-token", jwt);
		expect(await response.json()).toEqual({ link_token: "link-value" });
		expect(requests[0]?.url).toBe(
			"https://sandbox.plaid.com/link/token/create",
		);
		expect(requests[0]?.body).toMatchObject({
			client_id: "client-id",
			secret: "plaid-secret",
			user: {
				client_user_id:
					"acfd6eb3e3e79d21fe5bf2b14b96a3e47e5fc4ed1ea174502d806c95fbf0ea1c",
			},
			client_name: "Tally",
			products: ["transactions"],
			country_codes: ["US"],
			language: "en",
			webhook: "https://tally.test/webhooks/plaid",
		});
		expect(JSON.stringify(requests[0]?.body)).not.toContain(
			"family.member@example.com",
		);
	});

	it("stores only the encrypted access token and bank attribution", async () => {
		const { jwt, jwk } = await accessIdentity();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const plaidResponses: Record<string, unknown>[] = [
			{ access_token: "access-private", item_id: "item-1" },
			{ item: { institution_id: "ins-1" } },
			{ institution: { name: "First Bank" } },
		];
		vi.stubGlobal("fetch", async (input: string | URL | Request) =>
			String(input).includes("cloudflareaccess.com")
				? Response.json({ keys: [jwk] })
				: Response.json(plaidResponses.shift()),
		);
		const response = await post(
			"/plaid/exchange",
			jwt,
			new URLSearchParams({ public_token: "public-private" }).toString(),
		);
		expect(response.status).toBe(204);
		expect(JSON.stringify([...response.headers])).not.toMatch(/private/);
		expect(await response.text()).not.toMatch(/private/);
		expect(JSON.stringify([...response.headers])).not.toContain("item-1");
		expect(JSON.stringify(errors.mock.calls)).not.toContain("item-1");
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Linked First Bank.", type: "success" },
			announce: "Linked First Bank.",
		});
		const row = await env.DB.prepare(
			"SELECT access_token_encrypted, institution_name, linked_by, plaid_item_id FROM plaid_items",
		).first<{
			access_token_encrypted: ArrayBuffer;
			institution_name: string;
			linked_by: string;
			plaid_item_id: string;
		}>();
		expect(row?.institution_name).toBe("First Bank");
		expect(row?.linked_by).toBe("family.member@example.com");
		expect(row?.plaid_item_id).toBe("item-1");
		expect(
			await decryptToken(row?.access_token_encrypted as ArrayBuffer, KEY),
		).toBe("access-private");
	});

	it("stores the linked item with a fallback name when Plaid name lookup fails", async () => {
		const { jwt, jwk } = await accessIdentity();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let plaidRequest = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			if (String(input).includes("cloudflareaccess.com")) {
				return Response.json({ keys: [jwk] });
			}
			plaidRequest += 1;
			return plaidRequest === 1
				? Response.json({ access_token: "access-private", item_id: "item-1" })
				: Response.json(
						{
							error_type: "ITEM_ERROR",
							error_code: "ITEM_NOT_FOUND",
							request_id: "req-name-lookup",
						},
						{ status: 400 },
					);
		});

		const response = await post(
			"/plaid/exchange",
			jwt,
			new URLSearchParams({ public_token: "public-private" }).toString(),
		);

		expect(response.status).toBe(204);
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Linked Your bank.", type: "success" },
			announce: "Linked Your bank.",
		});
		const row = await env.DB.prepare(
			"SELECT access_token_encrypted, institution_name FROM plaid_items",
		).first<{
			access_token_encrypted: ArrayBuffer;
			institution_name: string;
		}>();
		expect(row?.institution_name).toBe("Your bank");
		expect(
			await decryptToken(row?.access_token_encrypted as ArrayBuffer, KEY),
		).toBe("access-private");
		expect(errors).toHaveBeenCalledTimes(1);
		expect(errors).toHaveBeenCalledWith("Plaid request failed", {
			request_id: "req-name-lookup",
		});
		expect(JSON.stringify(errors.mock.calls)).not.toMatch(
			/access-private|public-private|ITEM_ERROR|ITEM_NOT_FOUND/,
		);
	});

	it("shows a generic Plaid failure without storing or logging a token", async () => {
		const { jwt, jwk } = await accessIdentity();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", async (input: string | URL | Request) =>
			String(input).includes("cloudflareaccess.com")
				? Response.json({ keys: [jwk] })
				: Response.json(
						{
							error_type: "ITEM_ERROR",
							error_code: "BAD",
							request_id: "req-7",
						},
						{ status: 400 },
					),
		);
		const response = await post(
			"/plaid/exchange",
			jwt,
			new URLSearchParams({ public_token: "never-log-this" }).toString(),
		);
		expect(response.status).toBe(502);
		expect(await response.text()).toContain(
			'<p role="alert">Couldn&#39;t link the bank. Try again.</p>',
		);
		expect(errors).toHaveBeenCalledWith("Plaid request failed", {
			request_id: "req-7",
		});
		expect(JSON.stringify(errors.mock.calls)).not.toContain("never-log-this");
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) n FROM plaid_items").first<{
					n: number;
				}>()
			)?.n,
		).toBe(0);
	});

	it("rejects an invalid encryption key before calling Plaid", async () => {
		const { jwt, jwk } = await accessIdentity();
		Object.assign(env, { TOKEN_ENCRYPTION_KEY: "invalid" });
		const plaidFetch = vi.fn();
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			if (String(input).includes("cloudflareaccess.com")) {
				return Response.json({ keys: [jwk] });
			}
			plaidFetch(input);
			return Response.json({ access_token: "must-not-exist" });
		});

		expect(
			(await post("/plaid/exchange", jwt, "public_token=single-use")).status,
		).toBe(404);
		expect(plaidFetch).not.toHaveBeenCalled();
	});

	it("removes the Plaid item when storing its exchanged token fails", async () => {
		const { jwt, jwk } = await accessIdentity();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const plaidRequests: Array<{ url: string; body: Record<string, unknown> }> =
			[];
		await env.DB.exec(
			"CREATE TRIGGER fail_plaid_insert BEFORE INSERT ON plaid_items BEGIN SELECT RAISE(ABORT, 'failed insert'); END",
		);
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input).includes("cloudflareaccess.com")) {
					return Response.json({ keys: [jwk] });
				}
				plaidRequests.push({
					url: String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				if (String(input).endsWith("/item/public_token/exchange")) {
					return Response.json({
						access_token: "access-private",
						item_id: "item-1",
					});
				}
				if (String(input).endsWith("/item/get")) {
					return Response.json({ item: {} });
				}
				return Response.json({ request_id: "req-remove" });
			},
		);

		const response = await post(
			"/plaid/exchange",
			jwt,
			"public_token=single-use",
		);
		await env.DB.exec("DROP TRIGGER fail_plaid_insert");

		expect(response.status).toBe(502);
		expect(plaidRequests.at(-1)).toEqual({
			url: "https://sandbox.plaid.com/item/remove",
			body: {
				access_token: "access-private",
				client_id: "client-id",
				secret: "plaid-secret",
			},
		});
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) n FROM plaid_items").first<{
					n: number;
				}>()
			)?.n,
		).toBe(0);
		expect(JSON.stringify(errors.mock.calls)).not.toContain("access-private");
	});

	it("rejects a duplicate Plaid item id and removes the second Item", async () => {
		const { jwt, jwk } = await accessIdentity();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Existing Bank', 'family@example.com', 'item-duplicate')",
		)
			.bind(new Uint8Array([1, 2, 3]))
			.run();
		const plaidRequests: Array<{ url: string; body: Record<string, unknown> }> =
			[];
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input).includes("cloudflareaccess.com")) {
					return Response.json({ keys: [jwk] });
				}
				plaidRequests.push({
					url: String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				if (String(input).endsWith("/item/public_token/exchange")) {
					return Response.json({
						access_token: "access-second",
						item_id: "item-duplicate",
					});
				}
				if (String(input).endsWith("/item/get")) {
					return Response.json({ item: {} });
				}
				return Response.json({ request_id: "req-remove-duplicate" });
			},
		);

		const response = await post(
			"/plaid/exchange",
			jwt,
			"public_token=single-use",
		);

		expect(response.status).toBe(502);
		expect(await response.text()).toContain("Couldn&#39;t link the bank");
		expect(plaidRequests.at(-1)?.url).toBe(
			"https://sandbox.plaid.com/item/remove",
		);
		expect(plaidRequests.at(-1)?.body.access_token).toBe("access-second");
		expect(
			(
				await env.DB.prepare("SELECT COUNT(*) n FROM plaid_items").first<{
					n: number;
				}>()
			)?.n,
		).toBe(1);
		expect(JSON.stringify([...response.headers])).not.toContain(
			"item-duplicate",
		);
		expect(JSON.stringify(errors.mock.calls)).not.toContain("item-duplicate");
	});

	it("returns 415 for malformed JSON request bodies", async () => {
		const { jwt, jwk } = await accessIdentity();
		vi.stubGlobal("fetch", async () => Response.json({ keys: [jwk] }));
		const response = await exports.default.fetch(`${BASE}/plaid/exchange`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"content-type": "application/json",
				"Cf-Access-Jwt-Assertion": jwt,
			},
			body: "{malformed",
		});
		expect(response.status).toBe(415);
		expect(await response.text()).toContain("Couldn&#39;t link the bank");
	});

	it("rejects cross-site JSON exchanges without calling Plaid", async () => {
		const { jwt, jwk } = await accessIdentity();
		const plaidFetch = vi.fn();
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			if (String(input).includes("cloudflareaccess.com")) {
				return Response.json({ keys: [jwk] });
			}
			plaidFetch(input);
			return Response.json({ access_token: "must-not-exist" });
		});

		const response = await exports.default.fetch(`${BASE}/plaid/exchange`, {
			method: "POST",
			headers: {
				Origin: "https://evil.example",
				"content-type": "application/json",
				"Cf-Access-Jwt-Assertion": jwt,
			},
			body: JSON.stringify({ public_token: "single-use" }),
		});

		expect(response.status).toBe(403);
		expect(plaidFetch).not.toHaveBeenCalled();
	});

	it("rejects cross-site bodiless Link-token requests without calling Plaid", async () => {
		const { jwt, jwk } = await accessIdentity();
		const plaidFetch = vi.fn();
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			if (String(input).includes("cloudflareaccess.com")) {
				return Response.json({ keys: [jwk] });
			}
			plaidFetch(input);
			return Response.json({ link_token: "must-not-exist" });
		});

		const response = await exports.default.fetch(`${BASE}/plaid/link-token`, {
			method: "POST",
			headers: {
				Origin: "https://evil.example",
				"Cf-Access-Jwt-Assertion": jwt,
			},
		});

		expect(response.status).toBe(403);
		expect(plaidFetch).not.toHaveBeenCalled();
	});

	it("rejects non-form exchanges from the same origin without calling Plaid", async () => {
		const { jwt, jwk } = await accessIdentity();
		const plaidFetch = vi.fn();
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			if (String(input).includes("cloudflareaccess.com")) {
				return Response.json({ keys: [jwk] });
			}
			plaidFetch(input);
			return Response.json({ access_token: "must-not-exist" });
		});

		const response = await exports.default.fetch(`${BASE}/plaid/exchange`, {
			method: "POST",
			headers: {
				Origin: BASE,
				"content-type": "application/json",
				"Cf-Access-Jwt-Assertion": jwt,
			},
			body: JSON.stringify({ public_token: "single-use" }),
		});

		expect(response.status).toBe(415);
		expect(await response.text()).toContain("Couldn&#39;t link the bank");
		expect(plaidFetch).not.toHaveBeenCalled();
	});

	it("returns 404 in the demo or when required configuration is absent", async () => {
		Object.assign(env, { DEMO: "true" });
		expect((await post("/plaid/link-token")).status).toBe(404);
		Object.assign(env, { DEMO: "false", PLAID_SECRET: undefined });
		expect((await post("/plaid/exchange")).status).toBe(403);
		const { jwt, jwk } = await accessIdentity();
		vi.stubGlobal("fetch", async () => Response.json({ keys: [jwk] }));
		expect((await post("/plaid/exchange", jwt)).status).toBe(404);
	});

	it("rejects cross-site posts and an unverified production identity", async () => {
		const crossSite = await exports.default.fetch(`${BASE}/plaid/link-token`, {
			method: "POST",
			headers: { Origin: "https://evil.example" },
		});
		expect(crossSite.status).toBe(403);
		expect((await post("/plaid/link-token")).status).toBe(403);
	});
});
