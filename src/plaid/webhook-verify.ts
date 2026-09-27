import { type PlaidEnv, plaidPost } from "./client";

type Header = { alg?: unknown; kid?: unknown; crit?: unknown };
type Claims = { iat?: unknown; request_body_sha256?: unknown };
type VerificationKey = JsonWebKey & { expired_at?: unknown };
type CachedKey = { key: CryptoKey; fetchedAt: number };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_SECONDS = 5 * 60;
const keys = new Map<string, CachedKey>();

function decode(part: string): Uint8Array {
	if (!BASE64URL.test(part) || part.length % 4 === 1) {
		throw new Error("Invalid base64url");
	}
	const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
	return Uint8Array.from(
		atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
		(character) => character.charCodeAt(0),
	);
}

function json<T>(part: string): T {
	return JSON.parse(new TextDecoder().decode(decode(part))) as T;
}

async function verificationKey(
	env: PlaidEnv,
	kid: string,
	fetchImpl: typeof fetch,
): Promise<CryptoKey> {
	const cached = keys.get(kid);
	if (cached && Date.now() - cached.fetchedAt < KEY_TTL_MS) return cached.key;
	const response = await plaidPost<{ key?: VerificationKey }>(
		env,
		"/webhook_verification_key/get",
		{ key_id: kid },
		fetchImpl,
	);
	if (!response.key || response.key.expired_at !== null) {
		throw new Error("Invalid Plaid verification key");
	}
	const key = await crypto.subtle.importKey(
		"jwk",
		response.key,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
	keys.set(kid, { key, fetchedAt: Date.now() });
	return key;
}

/** Verifies that Plaid signed this exact request body. */
export async function verifyPlaidWebhook(
	env: PlaidEnv,
	rawBody: string,
	headerValue: string | undefined | null,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	if (!headerValue) return false;
	try {
		const parts = headerValue.split(".");
		if (parts.length !== 3 || parts.some((part) => !BASE64URL.test(part))) {
			return false;
		}
		const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] =
			parts;
		const header = json<Header>(encodedHeader);
		if (
			header.alg !== "ES256" ||
			typeof header.kid !== "string" ||
			header.kid.length === 0 ||
			header.crit !== undefined
		) {
			return false;
		}
		const signature = decode(encodedSignature);
		if (signature.length !== 64) return false;
		const key = await verificationKey(env, header.kid, fetchImpl);
		if (
			!(await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				key,
				signature,
				new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
			))
		) {
			return false;
		}
		const claims = json<Claims>(encodedClaims);
		const now = Date.now() / 1000;
		if (
			typeof claims.iat !== "number" ||
			!Number.isFinite(claims.iat) ||
			claims.iat < now - MAX_AGE_SECONDS ||
			claims.iat > now ||
			typeof claims.request_body_sha256 !== "string" ||
			!LOWERCASE_SHA256.test(claims.request_body_sha256)
		) {
			return false;
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
		return difference === 0;
	} catch {
		return false;
	}
}
