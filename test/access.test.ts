import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifiedEmail } from "../src/access";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const encoder = new TextEncoder();
const encode = (value: unknown) =>
	btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

async function keys() {
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
	return {
		privateKey: pair.privateKey,
		jwk: {
			...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
			kid: "test-key",
			alg: "RS256",
			use: "sig",
		},
	};
}

async function token(
	privateKey: CryptoKey,
	team: string,
	overrides: Record<string, unknown> = {},
	header: Record<string, unknown> = {},
) {
	const now = Math.floor(Date.now() / 1000);
	const encodedHeader = encode({ alg: "RS256", kid: "test-key", ...header });
	const encodedPayload = encode({
		aud: ["test-aud"],
		iss: `https://${team}`,
		exp: now + 300,
		nbf: now - 60,
		email: "Family.Member@Example.COM",
		...overrides,
	});
	const signed = `${encodedHeader}.${encodedPayload}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			privateKey,
			encoder.encode(signed),
		),
	);
	return `${signed}.${btoa(String.fromCharCode(...signature))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "")}`;
}

const request = (jwt?: string, emailHeader?: string) =>
	new Request("https://tally.test/", {
		headers: {
			...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
			...(emailHeader
				? { "Cf-Access-Authenticated-User-Email": emailHeader }
				: {}),
		},
	});

describe("verifiedEmail", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns a lower-cased email and caches the certs across verifications", async () => {
		const team = "valid.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		const fetch = vi.fn(async () => Response.json({ keys: [jwk] }));
		vi.stubGlobal("fetch", fetch);
		const jwt = await token(privateKey, team);

		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBe("family.member@example.com");
		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBe("family.member@example.com");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(`https://${team}/cdn-cgi/access/certs`);
	});

	it.each([
		["wrong audience", { aud: ["another-aud"] }, {}],
		["wrong issuer", { iss: "https://elsewhere.cloudflareaccess.com" }, {}],
		["expired", { exp: Math.floor(Date.now() / 1000) - 61 }, {}],
		["not active", { nbf: Math.floor(Date.now() / 1000) + 120 }, {}],
		["alg none", {}, { alg: "none" }],
		["alg HS256", {}, { alg: "HS256" }],
	])("rejects %s", async (_name, claims, header) => {
		const team = `${String(_name).replaceAll(" ", "-")}.cloudflareaccess.com`;
		const { privateKey, jwk } = await keys();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ keys: [jwk] })),
		);
		const jwt = await token(privateKey, team, claims, header);
		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
	});

	it("rejects a tampered payload", async () => {
		const team = "tampered.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ keys: [jwk] })),
		);
		const jwt = await token(privateKey, team);
		const [header, , signature] = jwt.split(".");
		const forged = `${header}.${encode({ aud: ["test-aud"], iss: `https://${team}`, exp: Math.floor(Date.now() / 1000) + 300, email: "attacker@example.com" })}.${signature}`;
		expect(
			await verifiedEmail(request(forged), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
	});

	it("refetches once and rejects an unknown kid", async () => {
		const team = "unknown.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		const fetch = vi.fn(async () =>
			Response.json({ keys: [{ ...jwk, kid: "another-key" }] }),
		);
		vi.stubGlobal("fetch", fetch);
		const jwt = await token(privateKey, team);
		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects missing configuration, a missing JWT, and the plain email header", async () => {
		expect(
			await verifiedEmail(request(undefined, "forged@example.com"), {
				ACCESS_TEAM_DOMAIN: "plain.cloudflareaccess.com",
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
		expect(await verifiedEmail(request("token"), {})).toBeNull();
	});
});

describe("Access middleware", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayUtc());
		Object.assign(env, {
			DEMO: "false",
			ACCESS_TEAM_DOMAIN: "route.cloudflareaccess.com",
			ACCESS_AUD: "test-aud",
		});
	});
	afterEach(() => {
		Object.assign(env, {
			DEMO: "true",
			ACCESS_TEAM_DOMAIN: undefined,
			ACCESS_AUD: undefined,
		});
		vi.unstubAllGlobals();
	});

	it("does not trust the plain email header on a real route", async () => {
		const response = await exports.default.fetch("http://tally.test/", {
			headers: { "Cf-Access-Authenticated-User-Email": "forged@example.com" },
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Sign in through Cloudflare Access.");
	});

	it("records the verified email on a transaction write", async () => {
		const { privateKey, jwk } = await keys();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ keys: [jwk] })),
		);
		const jwt = await token(privateKey, "route.cloudflareaccess.com");
		const id = (
			await env.DB.prepare("SELECT id FROM transactions LIMIT 1").first<{
				id: number;
			}>()
		)?.id;
		const response = await exports.default.fetch(
			`http://tally.test/transactions/${id}`,
			{
				method: "POST",
				redirect: "manual",
				headers: {
					Origin: "http://tally.test",
					"content-type": "application/x-www-form-urlencoded",
					"Cf-Access-Jwt-Assertion": jwt,
				},
				body: new URLSearchParams({
					category: "1",
					merchant: "",
					note: "",
					back: "/transactions",
				}).toString(),
			},
		);
		expect(response.status).toBe(303);
		const row = await env.DB.prepare(
			"SELECT updated_by FROM transactions WHERE id = ?",
		)
			.bind(id)
			.first<{ updated_by: string }>();
		expect(row?.updated_by).toBe("family.member@example.com");
	});

	it("keeps the demo identity and does not block the webhook path", async () => {
		Object.assign(env, { DEMO: "true" });
		const webhook = await exports.default.fetch(
			"http://tally.test/webhooks/plaid",
			{ method: "POST", headers: { Origin: "http://tally.test" } },
		);
		expect(webhook.status).not.toBe(403);
	});
});
