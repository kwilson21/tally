// base64url (RFC 4648 §5) without padding: how the VAPID keys, a push subscription's keys and the VAPID JWT are written (RFC 8292
// and RFC 8291). Decoding is strict, so a value with a character outside the alphabet is no key.

/** The bytes as base64url, without padding. */
export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** The bytes a base64url text stands for, or null when it isn't base64url. */
export function fromBase64Url(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
	const padded = text
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(text.length + ((4 - (text.length % 4)) % 4), "=");
	try {
		return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}
