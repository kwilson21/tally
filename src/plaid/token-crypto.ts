// Encrypts Plaid access tokens with a versioned format so encryption can evolve during future key rotations.

const VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ERROR = "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64";

function decodeKey(keyBase64: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) throw new Error(KEY_ERROR);

	try {
		const binary = atob(keyBase64);
		const key = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		if (key.byteLength !== 32) throw new Error(KEY_ERROR);
		return key;
	} catch {
		throw new Error(KEY_ERROR);
	}
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		decodeKey(keyBase64),
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptToken(
	plaintext: string,
	keyBase64: string,
): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			await importKey(keyBase64),
			new TextEncoder().encode(plaintext),
		),
	);
	const stored = new Uint8Array(1 + IV_LENGTH + ciphertext.byteLength);
	stored[0] = VERSION;
	stored.set(iv, 1);
	stored.set(ciphertext, 1 + IV_LENGTH);
	return stored;
}

export async function decryptToken(
	stored: Uint8Array | ArrayBuffer,
	keyBase64: string,
): Promise<string> {
	const bytes = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
	if (bytes.byteLength < 1 + IV_LENGTH + TAG_LENGTH)
		throw new Error("Encrypted token is too short");
	if (bytes[0] !== VERSION)
		throw new Error(`Unsupported encrypted token version: ${bytes[0]}`);

	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes.slice(1, 1 + IV_LENGTH) },
		await importKey(keyBase64),
		bytes.slice(1 + IV_LENGTH),
	);
	return new TextDecoder().decode(plaintext);
}
