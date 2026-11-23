import * as Effect from "effect/Effect";
import { PlaidBank } from "../machines/bank-request";
import {
	askLoginStillBroken,
	LOGIN_CHECK_WAIT,
	plaidBankFor,
} from "./bank-request";
import type { PlaidEnv } from "./client";

/**
 * Confirms that Plaid still reports a login error, failing safe when it cannot confirm (#1192): the check runs the
 * bank-request machine's login check (decision 245), so the sync and the Plaid webhook ask Plaid the same way.
 */
export async function loginStillBroken(
	env: PlaidEnv,
	accessTokenEncrypted: ArrayBuffer | Uint8Array | readonly number[],
	fetchImpl?: typeof fetch,
): Promise<boolean> {
	try {
		if (!env.TOKEN_ENCRYPTION_KEY) return true;

		return await Effect.runPromise(
			askLoginStillBroken(LOGIN_CHECK_WAIT).pipe(
				Effect.provideService(
					PlaidBank,
					plaidBankFor(
						env,
						{ access_token_encrypted: accessTokenEncrypted },
						{ fetchImpl, loginCheck: true },
					),
				),
			),
		);
	} catch {
		// A failed lookup counts as still broken, so the login error is kept when Plaid can't confirm. A repair that
		// landed meanwhile is still protected by the caller's seen state (decision 173).
		return true;
	}
}
