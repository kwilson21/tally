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
		expiredAt?: number | null;
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
		).toBe("valid");
		expect(
			await verifyPlaidWebhook(env, valid.body, valid.token, valid.fetchImpl),
		).toBe("valid");
		expect(valid.fetchImpl).toHaveBeenCalledOnce();
	});

	it.each([
		["HS256", { header: { alg: "HS256" } }],
		["none", { header: { alg: "none" } }],
		["missing kid", { header: { kid: undefined } }],
		["crit", { header: { crit: ["anything"] } }],
		["old iat", { claims: { iat: Math.floor(Date.now() / 1000) - 361 } }],
		[
			"iat 61 seconds ahead",
			{ claims: { iat: Math.floor(Date.now() / 1000) + 61 } },
		],
		["expired key", { expiredAt: 1_767_225_600 }],
	] as const)("rejects %s", async (_name, overrides) => {
		const value = await fixture(overrides);
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("invalid");
	});

	it("accepts an iat 30 seconds ahead", async () => {
		const value = await fixture({
			claims: { iat: Math.floor(Date.now() / 1000) + 30 },
		});
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("valid");
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
		).toBe("invalid");
		expect(
			await verifyPlaidWebhook(
				env,
				`${value.body} `,
				value.token,
				value.fetchImpl,
			),
		).toBe("invalid");
		// Change a character in the middle: the last one carries unused bits.
		const parts = value.token.split(".");
		const signature = parts[2] as string;
		const middle = Math.floor(signature.length / 2);
		parts[2] = `${signature.slice(0, middle)}${signature[middle] === "A" ? "B" : "A"}${signature.slice(middle + 1)}`;
		expect(
			await verifyPlaidWebhook(
				env,
				value.body,
				parts.join("."),
				value.fetchImpl,
			),
		).toBe("invalid");
	});

	it("rejects a signature whose unused trailing bits are set", async () => {
		const value = await fixture();
		const parts = value.token.split(".");
		const signature = parts[2] as string;
		// 64 bytes encode to 86 characters; the last holds 4 data bits and 2 unused ones.
		const alphabet =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const last = alphabet.indexOf(signature.at(-1) as string);
		parts[2] = `${signature.slice(0, -1)}${alphabet[last | 1]}`;
		expect(
			await verifyPlaidWebhook(
				env,
				value.body,
				parts.join("."),
				value.fetchImpl,
			),
		).toBe("invalid");
	});

	it("temporarily caches a failed key request as unavailable", async () => {
		vi.useFakeTimers();
		const value = await fixture({ fetchStatus: 500 });
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("unavailable");
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("unavailable");
		expect(value.fetchImpl).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(60_001);
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("unavailable");
		expect(value.fetchImpl).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("coalesces concurrent lookups for the same new kid", async () => {
		const value = await fixture();
		const [first, second] = await Promise.all([
			verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
			verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		]);
		expect([first, second]).toEqual(["valid", "valid"]);
		expect(value.fetchImpl).toHaveBeenCalledOnce();
	});

	it("refetches a cached key after one hour", async () => {
		vi.useFakeTimers();
		const value = await fixture();
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("valid");
		vi.advanceTimersByTime(60 * 60 * 1000);
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("invalid");
		expect(value.fetchImpl).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("caps failed kid entries at 32 and evicts the oldest", async () => {
		const value = await fixture({ fetchStatus: 500 });
		const parts = value.token.split(".");
		const tokenFor = (kid: string) =>
			`${json64({ alg: "ES256", kid })}.${parts[1]}.${parts[2]}`;
		for (let index = 0; index < 33; index += 1) {
			await verifyPlaidWebhook(
				env,
				value.body,
				tokenFor(`bounded-kid-${index}`),
				value.fetchImpl,
			);
		}
		await verifyPlaidWebhook(
			env,
			value.body,
			tokenFor("bounded-kid-0"),
			value.fetchImpl,
		);
		expect(value.fetchImpl).toHaveBeenCalledTimes(34);
	});

	it("rejects an over-long kid without fetching", async () => {
		const value = await fixture({ header: { kid: "k".repeat(129) } });
		expect(
			await verifyPlaidWebhook(env, value.body, value.token, value.fetchImpl),
		).toBe("invalid");
		expect(value.fetchImpl).not.toHaveBeenCalled();
	});
});
