import { type PlaidEnv, plaidPost } from "./client";

type Header = { alg?: unknown; kid?: unknown; crit?: unknown };
type Claims = { iat?: unknown; request_body_sha256?: unknown };
type VerificationKey = JsonWebKey & { expired_at?: unknown };
type CachedKey = { key: CryptoKey; fetchedAt: number };
type FailedKey = { result: "invalid" | "unavailable"; failedAt: number };
type KeyLookup =
	| { result: "valid"; key: CryptoKey }
	| { result: "invalid" | "unavailable" };
export type PlaidWebhookVerification = "valid" | "invalid" | "unavailable";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const KEY_TTL_MS = 60 * 60 * 1000;
const FAILED_KEY_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 32;
const MAX_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_SECONDS = 60;
const keys = new Map<string, CachedKey>();
const failedKeys = new Map<string, FailedKey>();
const inFlightKeys = new Map<string, Promise<KeyLookup>>();

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
	if (!map.has(key) && map.size >= MAX_CACHE_ENTRIES) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

function decode(part: string): Uint8Array {
	if (!BASE64URL.test(part) || part.length % 4 === 1) {
		throw new Error("Invalid base64url");
	}
	const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
	// Only the canonical spelling: unused trailing bits must be zero, so one value has one encoding.
	const canonical = btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
	if (canonical !== part) throw new Error("Invalid base64url");
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function json<T>(part: string): T {
	return JSON.parse(new TextDecoder().decode(decode(part))) as T;
}

async function verificationKey(
	env: PlaidEnv,
	kid: string,
	fetchImpl: typeof fetch,
): Promise<KeyLookup> {
	const failed = failedKeys.get(kid);
	if (failed && Date.now() - failed.failedAt < FAILED_KEY_TTL_MS) {
		return { result: failed.result };
	}
	if (failed) failedKeys.delete(kid);
	const cached = keys.get(kid);
	if (cached && Date.now() - cached.fetchedAt < KEY_TTL_MS) {
		return { result: "valid", key: cached.key };
	}
	if (cached) keys.delete(kid);
	const pending = inFlightKeys.get(kid);
	if (pending) return pending;
	const lookup: Promise<KeyLookup> = (async () => {
		try {
			const response = await plaidPost<{ key?: VerificationKey }>(
				env,
				"/webhook_verification_key/get",
				{ key_id: kid },
				fetchImpl,
			);
			if (!response.key) throw new Error("Missing Plaid verification key");
			if (response.key.expired_at !== null) {
				setBounded(failedKeys, kid, {
					result: "invalid",
					failedAt: Date.now(),
				});
				return { result: "invalid" };
			}
			const key = await crypto.subtle.importKey(
				"jwk",
				response.key,
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["verify"],
			);
			setBounded(keys, kid, { key, fetchedAt: Date.now() });
			return { result: "valid", key };
		} catch {
			setBounded(failedKeys, kid, {
				result: "unavailable",
				failedAt: Date.now(),
			});
			return { result: "unavailable" };
		}
	})();
	inFlightKeys.set(kid, lookup);
	try {
		return await lookup;
	} finally {
		if (inFlightKeys.get(kid) === lookup) inFlightKeys.delete(kid);
	}
}

/** Verifies that Plaid signed this exact request body. */
export async function verifyPlaidWebhook(
	env: PlaidEnv,
	rawBody: string,
	headerValue: string | undefined | null,
	fetchImpl: typeof fetch = fetch,
): Promise<PlaidWebhookVerification> {
	if (!headerValue) return "invalid";
	try {
		const parts = headerValue.split(".");
		if (parts.length !== 3 || parts.some((part) => !BASE64URL.test(part))) {
			return "invalid";
		}
		const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] =
			parts;
		const header = json<Header>(encodedHeader);
		if (
			header.alg !== "ES256" ||
			typeof header.kid !== "string" ||
			header.kid.length === 0 ||
			header.kid.length > 128 ||
			header.crit !== undefined
		) {
			return "invalid";
		}
		const signature = decode(encodedSignature);
		if (signature.length !== 64) return "invalid";
		const keyLookup = await verificationKey(env, header.kid, fetchImpl);
		if (keyLookup.result !== "valid") return keyLookup.result;
		if (
			!(await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				keyLookup.key,
				signature,
				new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
			))
		) {
			return "invalid";
		}
		const claims = json<Claims>(encodedClaims);
		const now = Date.now() / 1000;
		if (
			typeof claims.iat !== "number" ||
			!Number.isFinite(claims.iat) ||
			claims.iat < now - MAX_AGE_SECONDS ||
			claims.iat > now + MAX_FUTURE_SECONDS ||
			typeof claims.request_body_sha256 !== "string" ||
			!LOWERCASE_SHA256.test(claims.request_body_sha256)
		) {
			return "invalid";
		}
		const actual = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)),
		);
		const expected = Uint8Array.from(
			claims.request_body_sha256.match(/../g) ?? [],
			(byte) => Number.parseInt(byte, 16),
		);
		let difference = actual.length ^ expected.length;
		for (let index = 0; index < actual.length; index += 1) {
			difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
		}
		return difference === 0 ? "valid" : "invalid";
	} catch {
		return "invalid";
	}
}
