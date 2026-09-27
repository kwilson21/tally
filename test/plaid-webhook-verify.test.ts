import { describe, expect, it, vi } from "vitest";
import { verifyPlaidWebhook } from "../src/plaid/webhook-verify";

const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
const json64 = (value: unknown) => b64(encoder.encode(JSON.stringify(value)));

async function fixture(
	overrides: {
		header?: Record<string, unknown>;
		claims?: Record<string, unknown>;
		expiredAt?: string | null;
		fetchStatus?: number;
	} = {},
) {
	const pair = (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const body = JSON.stringify({ item_id: "item-1", webhook_type: "ITEM" });
	const hash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(body)),
	);
	const kid = crypto.randomUUID();
	const header = json64({ alg: "ES256", kid, ...overrides.header });
	const claims = json64({
		iat: Math.floor(Date.now() / 1000),
		request_body_sha256: Array.from(hash, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
		...overrides.claims,
	});
	const signed = `${header}.${claims}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			encoder.encode(signed),
		),
	);
	const fetchImpl = vi.fn(async () =>
		Response.json(
			{
				key: {
					...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
					expired_at: overrides.expiredAt ?? null,
				},
			},
			{ status: overrides.fetchStatus ?? 200 },
		),
	);
	return {
		body,
		token: `${signed}.${b64(signature)}`,
		fetchImpl: fetchImpl as unknown as typeof fetch,
	};
}

const env = { PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" };

describe("verifyPlaidWebhook", () => {
	it("accepts a valid webhook and caches its key", async () => {
		const valid = await fixture();
		expect(
			await verifyPlaidWebhook(env, valid.body, valid.token, valid.fetchImpl),
		).toBe(true);
		expect(
			await verifyPlaidWebhook(env, valid.body, valid.token, valid.fetchImpl),
		).toBe(true);
		expect(valid.fetchImpl).toHaveBeenCalledOnce();
	});

	it.each([
		["HS256", { header: { alg: "HS256" } }],
		["none", { header: { alg: "none" } }],
		["missing kid", { header: { kid: undefined } }],
		["crit", { header: { crit: ["anything"] } }],
		["old iat", { claims: { iat: Math.floor(Date.now() / 1000) - 361 } }],
		["future iat", { claims: { iat: Math.floor(Date.now() / 1000) + 1 } }],
		["expired key", { expiredAt: "2026-01-01T00:00:00Z" }],
	] as const)("rejects %s", async (_name, overrides) => {
		const value = await fixture(overrides);
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe(false);
	});

	it("rejects malformed encodings, body changes, and signature changes", async () => {
		const value = await fixture();
		expect(
			await verifyPlaidWebhook(
				env,
				value.body,
				`a=.b.${value.token.split(".")[2]}`,
				value.fetchImpl,
			),
		).toBe(false);
		expect(
			await verifyPlaidWebhook(
				env,
				`${value.body} `,
				value.token,
				value.fetchImpl,
			),
		).toBe(false);
		const parts = value.token.split(".");
		const signature = parts[2] as string;
		parts[2] = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
		expect(
			await verifyPlaidWebhook(
				env,
				value.body,
				parts.join("."),
				value.fetchImpl,
			),
		).toBe(false);
	});

	it("does not cache a failed key request", async () => {
		const value = await fixture({ fetchStatus: 500 });
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe(false);
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe(false);
		expect(value.fetchImpl).toHaveBeenCalledTimes(2);
	});
});
