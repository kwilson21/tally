// Web Push without a dependency (decision 148), on WebCrypto alone. Three parts, each citing the RFC it follows:
// - encrypt: the message body, sealed for the subscriber (RFC 8291 §3, aes128gcm of RFC 8188: one record, no padding);
// - vapidAuthorization: the server's signed JWT that identifies it to the push service (RFC 8292);
// - sendPush: one POST to a subscription's endpoint, with the five headers the push service needs. It never throws and never
//   logs: a fetch error, a timeout, or a subscription whose keys won't encrypt all answer { status: null }.

import { fromBase64Url, toBase64Url } from "./base64url";
import type { VapidKeys } from "./keys";

/** A push subscription as the browser made it: the endpoint, and the keys the body is sealed with (base64url). */
export type PushSubscription = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

/** What the service worker shows: the title, the body and the path it opens (sw.js). */
export type PushPayload = { title: string; body: string; url: string };

/** The sender's key pair as a private JWK (d with x and y, RFC 7518 §6.2.2). Only a test injects one. */
export type SenderJwk = { d: string; x: string; y: string };

/** Test seams for encrypt: the sender's key pair and the salt. Both are random in production. */
export type EncryptOptions = { sender?: SenderJwk; salt?: Uint8Array };

/** Test seams for sendPush: the fetch, the timeout's signal, and the clock the VAPID JWT is dated from. */
export type SendOptions = {
	fetchImpl?: typeof fetch;
	timeoutSignal?: () => AbortSignal;
	nowSec?: number;
};

/** The RFC 8188 record size: one record holds the whole message (a push is far smaller). */
const RECORD_SIZE = 4096;

/** The VAPID JWT's subject: a URL, so no email address goes to the push services (RFC 8292 §2.1). */
const VAPID_SUBJECT = "https://tally.thesuperhuman.us";

/** The VAPID JWT's lifetime in seconds: twelve hours, under the 24 RFC 8292 §2 allows. */
const VAPID_LIFETIME_S = 43_200;

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

/** HKDF with SHA-256 (RFC 5869) to `length` bytes. */
async function hkdf(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	length: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
		"deriveBits",
	]);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt, info },
			key,
			length * 8,
		),
	);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(
		parts.reduce((total, part) => total + part.byteLength, 0),
	);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/**
 * The sender's public point and private key: the injected test pair, or a fresh pair. A fresh pair's public key is exported raw;
 * an injected one's comes from its x and y (a private key can't be exported).
 */
async function senderKeys(sender: SenderJwk | undefined) {
	if (!sender) {
		const pair = (await crypto.subtle.generateKey(P256, true, [
			"deriveBits",
		])) as CryptoKeyPair;
		return {
			privateKey: pair.privateKey,
			publicPoint: new Uint8Array(
				(await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
			),
		};
	}
	const x = fromBase64Url(sender.x);
	const y = fromBase64Url(sender.y);
	if (!x || !y) throw new Error("sender key is not base64url");
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", d: sender.d, x: sender.x, y: sender.y },
		P256,
		false,
		["deriveBits"],
	);
	return { privateKey, publicPoint: concat(new Uint8Array([0x04]), x, y) };
}

/**
 * The body for one push, sealed for the subscription (RFC 8291 §3.4, RFC 8188 §2). The header is the salt (16 bytes), the
 * record size (4096, big-endian), the length of the sender's key (65) and the sender's public point; then the record, the
 * plaintext with the last-record delimiter 0x02 and no padding, sealed with AES-128-GCM and its 16-byte tag. A key that isn't
 * on the curve or an auth secret that isn't 16 bytes throws (importKey and the length check).
 */
export async function encrypt(
	plaintext: Uint8Array,
	subscription: Pick<PushSubscription, "p256dh" | "auth">,
	options: EncryptOptions = {},
): Promise<Uint8Array> {
	const receiverPoint = fromBase64Url(subscription.p256dh);
	const auth = fromBase64Url(subscription.auth);
	if (receiverPoint?.length !== 65 || receiverPoint[0] !== 0x04)
		throw new Error("subscription key is not an uncompressed P-256 point");
	if (auth?.length !== 16) throw new Error("subscription auth is not 16 bytes");
	const receiverKey = await crypto.subtle.importKey(
		"raw",
		receiverPoint,
		P256,
		false,
		[],
	);
	const sender = await senderKeys(options.sender);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits(
			// The peer key's member is `public` (the spec and MDN). The generated Workers types name it `$public`, a reserved-word
			// escape; the runtime reads `public`, and the Appendix A test checks that it does.
			{
				name: "ECDH",
				public: receiverKey,
			} as unknown as SubtleCryptoDeriveKeyAlgorithm,
			sender.privateKey,
			256,
		),
	);
	// The combined secret, from the auth secret and the two public points (RFC 8291 §3.4).
	const keyInfo = concat(
		encoder.encode("WebPush: info\0"),
		receiverPoint,
		sender.publicPoint,
	);
	const ikm = await hkdf(shared, auth, keyInfo, 32);
	const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(
		ikm,
		salt,
		encoder.encode("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = await hkdf(
		ikm,
		salt,
		encoder.encode("Content-Encoding: nonce\0"),
		12,
	);
	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
		"encrypt",
	]);
	const record = concat(plaintext, new Uint8Array([0x02]));
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
	);
	const recordSize = new Uint8Array(4);
	new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
	return concat(
		salt,
		recordSize,
		new Uint8Array([sender.publicPoint.byteLength]),
		sender.publicPoint,
		sealed,
	);
}

/**
 * The Authorization header that signs the server in (RFC 8292 §2, §3): `vapid t=<JWT>, k=<public key>`. The JWT is ES256, with
 * the header {"typ":"JWT","alg":"ES256"} and the claims aud (the push service's origin), exp (twelve hours on) and sub (the
 * site's URL). WebCrypto returns the signature as the 64-byte r‖s a JWS needs.
 */
export async function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	nowSec: number,
): Promise<string> {
	const header = toBase64Url(
		encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
	);
	const claims = toBase64Url(
		encoder.encode(
			JSON.stringify({
				aud: new URL(endpoint).origin,
				exp: nowSec + VAPID_LIFETIME_S,
				sub: VAPID_SUBJECT,
			}),
		),
	);
	const signingInput = `${header}.${claims}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			keys.signingKey,
			encoder.encode(signingInput),
		),
	);
	return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/**
 * Sends one push to a subscription's endpoint (RFC 8030): a POST of the sealed payload, with TTL 600, Urgency high, the
 * octet-stream type, aes128gcm and the VAPID Authorization, and nothing else. Any HTTP answer comes back as its status. A fetch
 * that throws, a timeout, and a subscription whose keys won't encrypt all come back as a null status, so the caller counts
 * them as transient. It logs nothing: the caller logs counts only.
 */
export async function sendPush(
	subscription: PushSubscription,
	payload: PushPayload,
	keys: VapidKeys,
	options: SendOptions = {},
): Promise<{ status: number | null }> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutSignal =
		options.timeoutSignal ?? (() => AbortSignal.timeout(10_000));
	const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
	try {
		const body = await encrypt(
			encoder.encode(JSON.stringify(payload)),
			subscription,
		);
		const response = await fetchImpl(subscription.endpoint, {
			method: "POST",
			signal: timeoutSignal(),
			headers: {
				TTL: "600",
				Urgency: "high",
				"Content-Type": "application/octet-stream",
				"Content-Encoding": "aes128gcm",
				Authorization: await vapidAuthorization(
					subscription.endpoint,
					keys,
					nowSec,
				),
			},
			body,
		});
		return { status: response.status };
	} catch {
		return { status: null };
	}
}
