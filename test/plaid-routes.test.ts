import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken } from "../src/plaid/token-crypto";

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
		});
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
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
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Linked First Bank.", type: "success" },
			announce: "Linked First Bank.",
		});
		const row = await env.DB.prepare(
			"SELECT access_token_encrypted, institution_name, linked_by FROM plaid_items",
		).first<{
			access_token_encrypted: ArrayBuffer;
			institution_name: string;
			linked_by: string;
		}>();
		expect(row?.institution_name).toBe("First Bank");
		expect(row?.linked_by).toBe("family.member@example.com");
		expect(
			await decryptToken(row?.access_token_encrypted as ArrayBuffer, KEY),
		).toBe("access-private");
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
