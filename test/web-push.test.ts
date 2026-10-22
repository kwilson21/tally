import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url } from "../src/push/base64url";
import { vapidKeys } from "../src/push/keys";
import {
	encrypt,
	type PushPayload,
	sendPush,
	vapidAuthorization,
} from "../src/push/web-push";

// Web Push without a dependency (decision 149): RFC 8291 (aes128gcm over ECDH P-256), RFC 8188 (the record and its header) and
// RFC 8292 (the VAPID JWT). Every byte is checked against the RFC's own example: Appendix A's intermediate values, which give
// the body of its §5 example exactly. The RFC's Content-Length of 145 is wrong: the body is 144 bytes (86 header + 41 plaintext
// + 1 delimiter + 16 tag), so the test compares the bytes, never a length from the RFC.

// RFC 8291 Appendix A, as base64url with the whitespace removed.
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const UA_PUBLIC =
	"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const HEADER =
	"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const CIPHERTEXT =
	"8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";

const bytes = (text: string) => {
	const decoded = fromBase64Url(text);
	if (!decoded) throw new Error(`not base64url: ${text}`);
	return decoded;
};

/** The sender key pair in the form encrypt takes for a test: the JWK's d, x and y, from Appendix A's public point. */
const senderJwk = () => {
	const point = bytes(AS_PUBLIC);
	return {
		d: AS_PRIVATE,
		x: b64u(point.slice(1, 33)),
		y: b64u(point.slice(33, 65)),
	};
};

// RFC 8291 Appendix A's receiver (the user agent) key pair: its private scalar opens what the sender seals.
const UA_PRIVATE = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";

const b64u = (slice: Uint8Array) =>
	btoa(String.fromCharCode(...slice))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

/** The receiver's side (RFC 8291 §3.4 and RFC 8188 §2), written out here so the round trip is checked end to end. */
async function openRecord(
	body: Uint8Array,
	auth: string,
	uaPrivate: string,
	uaPublic: string,
): Promise<Uint8Array> {
	const salt = body.slice(0, 16);
	const idlen = body[20] ?? 0;
	const senderPublic = body.slice(21, 21 + idlen);
	const record = body.slice(21 + idlen);
	const uaPoint = bytes(uaPublic);
	const uaKey = await crypto.subtle.importKey(
		"jwk",
		{
			kty: "EC",
			crv: "P-256",
			d: uaPrivate,
			x: b64u(uaPoint.slice(1, 33)),
			y: b64u(uaPoint.slice(33, 65)),
		},
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		["deriveBits"],
	);
	const senderKey = await crypto.subtle.importKey(
		"raw",
		senderPublic,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const ecdh = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "ECDH",
				public: senderKey,
			} as unknown as SubtleCryptoDeriveKeyAlgorithm,
			uaKey,
			256,
		),
	);
	const enc = new TextEncoder();
	const expand = async (
		ikm: Uint8Array,
		hkdfSalt: Uint8Array,
		info: Uint8Array,
		length: number,
	) => {
		const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
			"deriveBits",
		]);
		return new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: "HKDF", hash: "SHA-256", salt: hkdfSalt, info },
				key,
				length * 8,
			),
		);
	};
	const keyInfo = new Uint8Array([
		...enc.encode("WebPush: info\0"),
		...uaPoint,
		...senderPublic,
	]);
	const ikm = await expand(ecdh, bytes(auth), keyInfo, 32);
	const cek = await expand(
		ikm,
		salt,
		enc.encode("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = await expand(
		ikm,
		salt,
		enc.encode("Content-Encoding: nonce\0"),
		12,
	);
	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
		"decrypt",
	]);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
	);
	if (plain[plain.length - 1] !== 0x02)
		throw new Error("no last-record delimiter");
	return plain.slice(0, -1);
}

const SUBSCRIPTION = {
	endpoint: "https://push.example.test/send/abc",
	p256dh: UA_PUBLIC,
	auth: AUTH,
};

const PAYLOAD: PushPayload = {
	title: "Tally",
	body: "Your three questions are ready. About three minutes to finish setting up your budget.",
	url: "/first-page",
};

/** VAPID keys from the RFC's sender pair: a valid P-256 pair, so the signing key and its public key agree. */
const keys = async () => {
	const pair = await vapidKeys({
		VAPID_PUBLIC_KEY: AS_PUBLIC,
		VAPID_PRIVATE_KEY: AS_PRIVATE,
	});
	if (!pair) throw new Error("the RFC pair should make keys");
	return pair;
};

describe("encrypt (RFC 8291, aes128gcm)", () => {
	it("reproduces the body of RFC 8291 Appendix A byte for byte", async () => {
		const body = await encrypt(
			new TextEncoder().encode(PLAINTEXT),
			{ p256dh: UA_PUBLIC, auth: AUTH },
			{ sender: senderJwk(), salt: bytes(SALT) },
		);
		expect(body.byteLength).toBe(144);
		// The two parts are decoded apart: the header is 86 bytes, not a multiple of 3, so joining their base64url would be wrong.
		expect(body).toEqual(
			new Uint8Array([...bytes(HEADER), ...bytes(CIPHERTEXT)]),
		);
	});

	it("writes the RFC 8188 header: a 16-byte salt, record size 4096, and the sender's key with its length", async () => {
		const body = await encrypt(
			new TextEncoder().encode(PLAINTEXT),
			{ p256dh: UA_PUBLIC, auth: AUTH },
			{ sender: senderJwk(), salt: bytes(SALT) },
		);
		const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
		expect(body.slice(0, 16)).toEqual(bytes(SALT));
		expect(view.getUint32(16)).toBe(4096);
		expect(body[20]).toBe(65);
		expect(body.slice(21, 86)).toEqual(bytes(AS_PUBLIC));
	});

	it("makes a fresh salt and sender key each time when none are given", async () => {
		const plaintext = new TextEncoder().encode(PLAINTEXT);
		const first = await encrypt(plaintext, { p256dh: UA_PUBLIC, auth: AUTH });
		const second = await encrypt(plaintext, { p256dh: UA_PUBLIC, auth: AUTH });
		expect(first.slice(0, 16)).not.toEqual(second.slice(0, 16));
		expect(first.slice(21, 86)).not.toEqual(second.slice(21, 86));
		expect(first.byteLength).toBe(86 + plaintext.byteLength + 1 + 16);
	});

	it("rejects a user agent key that is not on the P-256 curve", async () => {
		const notOnCurve = new Uint8Array(65);
		notOnCurve[0] = 0x04;
		notOnCurve.fill(7, 1);
		await expect(
			encrypt(
				new TextEncoder().encode(PLAINTEXT),
				{
					p256dh: btoa(String.fromCharCode(...notOnCurve))
						.replaceAll("+", "-")
						.replaceAll("/", "_")
						.replace(/=+$/, ""),
					auth: AUTH,
				},
				{ sender: senderJwk(), salt: bytes(SALT) },
			),
		).rejects.toThrow();
	});
});

describe("vapidAuthorization (RFC 8292)", () => {
	const NOW = 1_800_000_000;

	/** Splits the header into its JWT and its key, and reads the JWT's three parts. */
	const parse = (header: string) => {
		const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
		if (!match) throw new Error(`bad header ${header}`);
		const [, token = "", key = ""] = match;
		const [headerPart = "", claimsPart = "", signaturePart = ""] =
			token.split(".");
		const json = (part: string) =>
			JSON.parse(new TextDecoder().decode(bytes(part)));
		return {
			key,
			token,
			header: json(headerPart),
			claims: json(claimsPart),
			signingInput: `${headerPart}.${claimsPart}`,
			signature: bytes(signaturePart),
		};
	};

	it("is the vapid scheme with the JWT and the public key, and the JWT's header is exact", async () => {
		const header = await vapidAuthorization(
			SUBSCRIPTION.endpoint,
			await keys(),
			NOW,
		);
		const parsed = parse(header);
		expect(parsed.key).toBe(AS_PUBLIC);
		expect(parsed.header).toEqual({ typ: "JWT", alg: "ES256" });
		expect(
			new TextDecoder().decode(bytes(parsed.token.split(".")[0] ?? "")),
		).toBe('{"typ":"JWT","alg":"ES256"}');
	});

	it("has exact aud, exp and sub claims: the push origin, twelve hours on, and the site's URL", async () => {
		const parsed = parse(
			await vapidAuthorization(SUBSCRIPTION.endpoint, await keys(), NOW),
		);
		expect(parsed.claims).toEqual({
			aud: "https://push.example.test",
			exp: NOW + 43_200,
			sub: "https://tally.thesuperhuman.us",
		});
		expect(Object.keys(parsed.claims)).toEqual(["aud", "exp", "sub"]);
	});

	it("signs with ES256, so the signature verifies with the public key", async () => {
		const parsed = parse(
			await vapidAuthorization(SUBSCRIPTION.endpoint, await keys(), NOW),
		);
		expect(parsed.signature.byteLength).toBe(64);
		const publicKey = await crypto.subtle.importKey(
			"raw",
			bytes(AS_PUBLIC),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		expect(
			await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				publicKey,
				parsed.signature,
				new TextEncoder().encode(parsed.signingInput),
			),
		).toBe(true);
	});
});

describe("sendPush", () => {
	let logged: unknown[][];
	beforeEach(() => {
		logged = [];
		for (const name of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
				logged.push(args);
			});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A fetch that answers `status`, and records each request. */
	function answering(status: number) {
		const requests: { url: string; init: RequestInit }[] = [];
		const fetchImpl = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				requests.push({ url: String(url), init: init ?? {} });
				return new Response(null, { status });
			},
		);
		return { fetchImpl, requests };
	}

	it("posts the encrypted payload with exactly the five headers", async () => {
		const { fetchImpl, requests } = answering(201);
		const result = await sendPush(SUBSCRIPTION, PAYLOAD, await keys(), {
			fetchImpl,
			nowSec: 1_800_000_000,
		});
		expect(result).toEqual({ status: 201 });
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.url).toBe(SUBSCRIPTION.endpoint);
		expect(request?.init.method).toBe("POST");
		const headers = request?.init.headers as Record<string, string>;
		expect(Object.keys(headers).sort()).toEqual(
			[
				"Authorization",
				"Content-Encoding",
				"Content-Type",
				"TTL",
				"Urgency",
			].sort(),
		);
		expect(headers.TTL).toBe("600");
		expect(headers.Urgency).toBe("high");
		expect(headers["Content-Type"]).toBe("application/octet-stream");
		expect(headers["Content-Encoding"]).toBe("aes128gcm");
		expect(headers.Authorization).toMatch(/^vapid t=[^,]+, k=/);
	});

	it("sends a body that the subscriber opens to the payload's JSON", async () => {
		const { fetchImpl, requests } = answering(201);
		await sendPush(SUBSCRIPTION, PAYLOAD, await keys(), { fetchImpl });
		const body = new Uint8Array(requests[0]?.init.body as ArrayBuffer);
		const opened = await openRecord(body, AUTH, UA_PRIVATE, UA_PUBLIC);
		expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(PAYLOAD);
	});

	it("returns the status of any HTTP answer, a 410 included", async () => {
		const { fetchImpl } = answering(410);
		expect(
			await sendPush(SUBSCRIPTION, PAYLOAD, await keys(), { fetchImpl }),
		).toEqual({ status: 410 });
	});

	it("returns a null status when the fetch throws", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("network down");
		});
		expect(
			await sendPush(SUBSCRIPTION, PAYLOAD, await keys(), { fetchImpl }),
		).toEqual({ status: null });
	});

	it("returns a null status when the request times out", async () => {
		const fetchImpl = vi.fn(
			(_url: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		expect(
			await sendPush(SUBSCRIPTION, PAYLOAD, await keys(), {
				fetchImpl,
				timeoutSignal: () => AbortSignal.timeout(1),
			}),
		).toEqual({ status: null });
	});

	it("returns a null status for a subscription whose key will not encrypt, without a request", async () => {
		const { fetchImpl } = answering(201);
		expect(
			await sendPush(
				{ ...SUBSCRIPTION, p256dh: "not-a-key" },
				PAYLOAD,
				await keys(),
				{ fetchImpl },
			),
		).toEqual({ status: null });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("logs nothing, whatever the answer", async () => {
		await sendPush(SUBSCRIPTION, PAYLOAD, await keys(), {
			fetchImpl: answering(500).fetchImpl,
		});
		await sendPush(SUBSCRIPTION, PAYLOAD, await keys(), {
			fetchImpl: vi.fn(async () => {
				throw new TypeError("network down");
			}),
		});
		expect(logged).toEqual([]);
	});
});
