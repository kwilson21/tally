// Makes one pair of VAPID keys for Web Push (decision 148, RFC 8292) and prints them as one line of JSON:
//   {"publicKey":"…","privateKey":"…"}
// The public key is the uncompressed P-256 point (65 bytes starting 0x04) and the private key is the scalar d (32 bytes), both
// base64url. Node's WebCrypto only, no dependency. The owner runs it through scripts/production-setup.sh, which sets each value
// as a secret without printing it. Setting new keys makes every device turn notifications on again, so it is never run in CI.

const pair = await crypto.subtle.generateKey(
	{ name: "ECDSA", namedCurve: "P-256" },
	true,
	["sign", "verify"],
);
const publicKey = Buffer.from(
	await crypto.subtle.exportKey("raw", pair.publicKey),
).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
if (typeof d !== "string") throw new Error("The private key has no scalar.");
process.stdout.write(`${JSON.stringify({ publicKey, privateKey: d })}\n`);
