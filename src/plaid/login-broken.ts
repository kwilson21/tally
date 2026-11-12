import { getItem, type PlaidEnv } from "./client";
import { decryptToken } from "./token-crypto";

/** Confirms that Plaid still reports a login error, failing safe when it cannot confirm. */
export async function loginStillBroken(
	env: PlaidEnv,
	accessTokenEncrypted: ArrayBuffer | Uint8Array | readonly number[],
	fetchImpl?: typeof fetch,
): Promise<boolean> {
	try {
		if (!env.TOKEN_ENCRYPTION_KEY) return true;

		const accessToken = await decryptToken(
			accessTokenEncrypted,
			env.TOKEN_ENCRYPTION_KEY,
		);

		const result = await getItem(env, accessToken, fetchImpl);

		return result.item?.error !== null;
	} catch {
		// A failed lookup counts as still broken, so the login error is kept when Plaid can't confirm. A repair that
		// landed meanwhile is still protected by the caller's seen state (decision 173).
		return true;
	}
}
