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

async function tokenWithPayload(
	privateKey: CryptoKey,
	payload: string,
	header: Record<string, unknown> = {},
) {
	const encodedHeader = encode({ alg: "RS256", kid: "test-key", ...header });
	const encodedPayload = btoa(payload)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
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
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

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
		expect(fetch).toHaveBeenCalledWith(`https://${team}/cdn-cgi/access/certs`, {
			redirect: "error",
		});
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

	it("fetches only once for an unknown kid when the cache is empty", async () => {
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
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not refetch for different unknown kids inside 30 seconds", async () => {
		const team = "unknown-cooldown.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		const fetch = vi.fn(async () => Response.json({ keys: [jwk] }));
		vi.stubGlobal("fetch", fetch);
		for (const kid of ["forged-one", "forged-two"]) {
			const jwt = await token(privateKey, team, {}, { kid });
			expect(
				await verifiedEmail(request(jwt), {
					ACCESS_TEAM_DOMAIN: team,
					ACCESS_AUD: "test-aud",
				}),
			).toBeNull();
		}
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("may refetch once for an unknown kid after 30 seconds", async () => {
		vi.useFakeTimers();
		const team = "unknown-after-cooldown.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		const fetch = vi.fn(async () => Response.json({ keys: [jwk] }));
		vi.stubGlobal("fetch", fetch);
		const jwt = await token(privateKey, team, {}, { kid: "forged" });
		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
		await vi.advanceTimersByTimeAsync(30_001);
		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("coalesces concurrent cert fetches for a domain", async () => {
		const team = "concurrent.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		let resolveFetch: ((response: Response) => void) | undefined;
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const jwt = await token(privateKey, team);
		const verification = Promise.all([
			verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
			verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		]);
		expect(fetch).toHaveBeenCalledTimes(1);
		resolveFetch?.(Response.json({ keys: [jwk] }));
		expect(await verification).toEqual([
			"family.member@example.com",
			"family.member@example.com",
		]);
	});

	it("rejects non-finite expiry and not-before claims", async () => {
		const team = "finite.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ keys: [jwk] })),
		);
		const base = `"aud":["test-aud"],"iss":"https://${team}","email":"member@example.com"`;
		const future = Math.floor(Date.now() / 1000) + 300;
		for (const claims of [
			`{${base},"exp":1e309}`,
			`{${base},"exp":${future},"nbf":1e309}`,
		]) {
			const jwt = await tokenWithPayload(privateKey, claims);
			expect(
				await verifiedEmail(request(jwt), {
					ACCESS_TEAM_DOMAIN: team,
					ACCESS_AUD: "test-aud",
				}),
			).toBeNull();
		}
	});

	it.each([
		"evil.com",
		"team.cloudflareaccess.com.evil.com",
		"user@team.cloudflareaccess.com",
		"team.cloudflareaccess.com/#",
	])("rejects invalid team domain %s without fetching", async (team) => {
		const { privateKey } = await keys();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const jwt = await token(privateKey, team);
		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects standard padded base64 in a token segment", async () => {
		const team = "strict-base64.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		const fetch = vi.fn(async () => Response.json({ keys: [jwk] }));
		vi.stubGlobal("fetch", fetch);
		const jwt = await token(privateKey, team);
		const [header, payload, signature = ""] = jwt.split(".");
		const standardSignature = signature
			.replaceAll("-", "+")
			.replaceAll("_", "/")
			.padEnd(Math.ceil(signature.length / 4) * 4, "=");
		expect(
			await verifiedEmail(
				request(`${header}.${payload}.${standardSignature}`),
				{
					ACCESS_TEAM_DOMAIN: team,
					ACCESS_AUD: "test-aud",
				},
			),
		).toBeNull();
	});

	it("rejects a critical protected header", async () => {
		const team = "critical.cloudflareaccess.com";
		const { privateKey, jwk } = await keys();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ keys: [jwk] })),
		);
		const jwt = await token(privateKey, team, {}, { crit: ["example"] });
		expect(
			await verifiedEmail(request(jwt), {
				ACCESS_TEAM_DOMAIN: team,
				ACCESS_AUD: "test-aud",
			}),
		).toBeNull();
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

	it("exempts only the exact webhook path outside the demo", async () => {
		const webhook = await exports.default.fetch(
			"http://tally.test/webhooks/plaid",
			{ method: "POST", headers: { Origin: "http://tally.test" } },
		);
		expect(webhook.status).not.toBe(403);
		for (const path of [
			"/webhooks/plaidX",
			"/webhooks/plaid/",
			"/design-systemX",
		]) {
			const response = await exports.default.fetch(`http://tally.test${path}`);
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("Sign in through Cloudflare Access.");
		}
	});
});
