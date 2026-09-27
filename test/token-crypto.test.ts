import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/plaid/token-crypto";

function randomKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes));
}

describe("Plaid token encryption", () => {
	it("round-trips a token", async () => {
		const key = randomKey();
		expect(
			await decryptToken(await encryptToken("access-token", key), key),
		).toBe("access-token");
	});

	it("uses a fresh IV for every encryption", async () => {
		const key = randomKey();
		const first = await encryptToken("same-token", key);
		const second = await encryptToken("same-token", key);
		expect(first).not.toEqual(second);
	});

	it("rejects the wrong key", async () => {
		const encrypted = await encryptToken("access-token", randomKey());
		await expect(decryptToken(encrypted, randomKey())).rejects.toThrow();
	});

	it("rejects every tampered IV or ciphertext byte", async () => {
		const key = randomKey();
		const encrypted = await encryptToken("access-token", key);
		for (let index = 1; index < encrypted.byteLength; index++) {
			const tampered = encrypted.slice();
			const byte = tampered[index];
			if (byte === undefined) throw new Error("Missing encrypted byte");
			tampered[index] = byte ^ 0x01;
			await expect(decryptToken(tampered, key)).rejects.toThrow();
		}
	});

	it("rejects an unknown version", async () => {
		const key = randomKey();
		const encrypted = await encryptToken("access-token", key);
		encrypted[0] = 0x02;
		await expect(decryptToken(encrypted, key)).rejects.toThrow(
			"Unsupported encrypted token version",
		);
	});

	it("rejects values too short to contain the layout and tag", async () => {
		await expect(decryptToken(new Uint8Array(28), randomKey())).rejects.toThrow(
			"Encrypted token is too short",
		);
	});

	it("rejects invalid keys without exposing them", async () => {
		for (const invalidKey of ["not base64!", btoa("sixteen-byte-key")]) {
			const error = await encryptToken("access-token", invalidKey).catch(
				(reason: unknown) => reason,
			);
			expect(error).toEqual(
				new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64"),
			);
			expect(String(error)).not.toContain(invalidKey);
		}
	});

	it("round-trips the Uint8Array through a D1 BLOB", async () => {
		const key = randomKey();
		const encrypted = await encryptToken("database-token", key);
		expect(encrypted).toBeInstanceOf(Uint8Array);
		await env.DB.exec(
			"CREATE TABLE token_crypto_test (encrypted BLOB NOT NULL)",
		);
		await env.DB.prepare("INSERT INTO token_crypto_test (encrypted) VALUES (?)")
			.bind(encrypted)
			.run();
		const row = await env.DB.prepare(
			"SELECT encrypted FROM token_crypto_test",
		).first<{ encrypted: number[] }>();
		if (!row) throw new Error("Missing encrypted token row");
		expect(Array.isArray(row.encrypted)).toBe(true);
		expect(await decryptToken(row.encrypted, key)).toBe("database-token");
	});
});
