import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/push/base64url";
import { vapidKeys } from "../src/push/keys";

// The VAPID keys (decision 148): two secrets, the uncompressed P-256 public key (65 bytes starting 0x04) and the private scalar
// (32 bytes), both base64url. vapidKeys reads them once for every caller, so Home's drawing, the route and the minute run agree.

/** A real P-256 pair, in the two forms the secrets take: the public point and the private scalar `d`. */
async function generatedPair() {
	const pair = (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const publicRaw = new Uint8Array(
		(await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
	);
	const jwk = (await crypto.subtle.exportKey(
		"jwk",
		pair.privateKey,
	)) as JsonWebKey;
	if (!jwk.d) throw new Error("no private scalar");
	const privateScalar = Uint8Array.from(atob(toPadded(jwk.d)), (c) =>
		c.charCodeAt(0),
	);
	return {
		publicKey: toBase64Url(publicRaw),
		privateKey: toBase64Url(privateScalar),
	};
}

/** base64url without padding back to base64 with padding, for atob. */
function toPadded(text: string) {
	const base = text.replaceAll("-", "+").replaceAll("_", "/");
	return base.padEnd(base.length + ((4 - (base.length % 4)) % 4), "=");
}

const bytesOf = (text: string) => {
	const padded = toPadded(text);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

describe("vapidKeys", () => {
	it("returns null when neither secret is set", async () => {
		expect(await vapidKeys({})).toBeNull();
	});

	it("returns null when only one secret is set", async () => {
		const pair = await generatedPair();
		expect(await vapidKeys({ VAPID_PUBLIC_KEY: pair.publicKey })).toBeNull();
		expect(await vapidKeys({ VAPID_PRIVATE_KEY: pair.privateKey })).toBeNull();
	});

	it("returns null for a public key that is not 65 bytes starting 0x04", async () => {
		const pair = await generatedPair();
		const compressed = toBase64Url(bytesOf(pair.publicKey).slice(0, 33));
		const notUncompressed = new Uint8Array(65);
		notUncompressed.set(bytesOf(pair.publicKey));
		notUncompressed[0] = 0x03;
		for (const publicKey of [
			compressed,
			toBase64Url(notUncompressed),
			toBase64Url(bytesOf(pair.publicKey).slice(0, 64)),
		]) {
			expect(
				await vapidKeys({
					VAPID_PUBLIC_KEY: publicKey,
					VAPID_PRIVATE_KEY: pair.privateKey,
				}),
			).toBeNull();
		}
	});

	it("returns null for a private key that is not 32 bytes", async () => {
		const pair = await generatedPair();
		for (const privateKey of [
			toBase64Url(bytesOf(pair.privateKey).slice(0, 31)),
			toBase64Url(new Uint8Array(33).fill(1)),
		]) {
			expect(
				await vapidKeys({
					VAPID_PUBLIC_KEY: pair.publicKey,
					VAPID_PRIVATE_KEY: privateKey,
				}),
			).toBeNull();
		}
	});

	it("returns null in the demo, whatever the secrets", async () => {
		const pair = await generatedPair();
		expect(
			await vapidKeys({
				VAPID_PUBLIC_KEY: pair.publicKey,
				VAPID_PRIVATE_KEY: pair.privateKey,
				DEMO: "true",
			}),
		).toBeNull();
	});

	it("returns the public key and a signing key for the pair, which signs for that public key", async () => {
		const pair = await generatedPair();
		const keys = await vapidKeys({
			VAPID_PUBLIC_KEY: pair.publicKey,
			VAPID_PRIVATE_KEY: pair.privateKey,
			DEMO: "false",
		});
		expect(keys?.publicKey).toBe(pair.publicKey);
		if (!keys) throw new Error("expected keys");
		const message = new TextEncoder().encode("signed by the server");
		const signature = await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			keys.signingKey,
			message,
		);
		expect(signature.byteLength).toBe(64);
		const verifying = await crypto.subtle.importKey(
			"raw",
			bytesOf(pair.publicKey),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		expect(
			await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				verifying,
				signature,
				message,
			),
		).toBe(true);
	});
});
