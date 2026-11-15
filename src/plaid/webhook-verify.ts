import * as Schema from "effect/Schema";
import { readStoredWith } from "../db/stored-shape";
import { askPlaid, orThrow, type PlaidEnv } from "./client";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

/** The token's first part (decision 206, #1149): ES256 with a key id, and no `crit`, which would name rules this check does not know. */
const Header = Schema.Struct({
	alg: Schema.Literal("ES256"),
	kid: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	crit: Schema.optionalKey(Schema.Never),
});

/** The token's second part: when it was issued, and the SHA-256 of the request body it signs, in lower-case hex. */
const Claims = Schema.Struct({
	iat: Schema.Finite,
	request_body_sha256: Schema.String.check(Schema.isPattern(LOWERCASE_SHA256)),
});

/**
 * Plaid's answer to the key fetch. The key is kept as sent: its expiry is read below, and Web Crypto's importKey is the
 * check of the key's own fields.
 */
const KeyAnswer = Schema.Struct({ key: Schema.optional(Schema.Unknown) });

type VerificationKey = JsonWebKey & { expired_at?: unknown };

/** True for a key Plaid sent as an object, the only kind that can carry an expiry. */
const isKeyObject = (value: unknown): value is VerificationKey =>
	typeof value === "object" && value !== null;

type CachedKey = { key: CryptoKey; fetchedAt: number };

type FailedKey = { result: "invalid" | "unavailable"; failedAt: number };

type KeyLookup =
	| { result: "valid"; key: CryptoKey }
	| { result: "invalid" | "unavailable" };

export type PlaidWebhookVerification = "valid" | "invalid" | "unavailable";

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

/** One base64url part of the token as the Schema's type, or null when its text is not JSON or not shaped like it. */
function readPart<S extends Schema.Constraint>(
	schema: S,
	part: string,
): S["Type"] | null {
	return readStoredWith(schema, new TextDecoder().decode(decode(part)));
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
			const response = await orThrow(
				askPlaid(
					env,
					"/webhook_verification_key/get",
					{ key_id: kid },
					KeyAnswer,
					fetchImpl,
				),
			);

			const sent = response.key;

			if (!sent) throw new Error("Missing Plaid verification key");

			// A key that is not an object has no expiry, so it is refused as an expired one is.
			if (!isKeyObject(sent) || sent.expired_at !== null) {
				setBounded(failedKeys, kid, {
					result: "invalid",
					failedAt: Date.now(),
				});

				return { result: "invalid" };
			}

			const key = await crypto.subtle.importKey(
				"jwk",
				sent,
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

		const header = readPart(Header, encodedHeader);

		if (header === null) return "invalid";

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

		const claims = readPart(Claims, encodedClaims);
		const now = Date.now() / 1000;

		if (
			claims === null ||
			claims.iat < now - MAX_AGE_SECONDS ||
			claims.iat > now + MAX_FUTURE_SECONDS
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
