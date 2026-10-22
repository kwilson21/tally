// The Web Push keys (decision 148): the two VAPID secrets, set with `wrangler secret put` (production only). One helper reads
// them for every caller (Home's drawing, the subscribe route and the minute run), so the three can't disagree about whether
// notifications are on. The private key is never logged or returned.

import { fromBase64Url, toBase64Url } from "./base64url";

/** The secrets the push reads, with the rest of the environment left out. Route files are typed Env, which has neither. */
export type PushEnv = {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	DEMO?: string;
};

/** The server's VAPID keys: the public key as the browser needs it, and the private key ready to sign (RFC 8292). */
export type VapidKeys = { publicKey: string; signingKey: CryptoKey };

/**
 * The VAPID keys, or null when push is off: the demo, either secret missing, or a secret the wrong size. The public key is an
 * uncompressed P-256 point (65 bytes starting 0x04) and the private key its scalar d (32 bytes), both base64url. A private
 * JWK needs x and y as well as d (RFC 7518 §6.2.2), so they come from the public key; WebCrypto can't import a bare scalar.
 */
export async function vapidKeys(env: PushEnv): Promise<VapidKeys | null> {
	if (env.DEMO === "true") return null;
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
	const publicBytes = fromBase64Url(env.VAPID_PUBLIC_KEY);
	const scalar = fromBase64Url(env.VAPID_PRIVATE_KEY);
	if (publicBytes?.length !== 65 || publicBytes[0] !== 0x04) return null;
	if (scalar?.length !== 32) return null;
	try {
		const signingKey = await crypto.subtle.importKey(
			"jwk",
			{
				kty: "EC",
				crv: "P-256",
				d: toBase64Url(scalar),
				x: toBase64Url(publicBytes.slice(1, 33)),
				y: toBase64Url(publicBytes.slice(33, 65)),
			},
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["sign"],
		);
		return { publicKey: toBase64Url(publicBytes), signingKey };
	} catch {
		return null;
	}
}
