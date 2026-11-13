// Runs one request about a bank through the bridged machine (src/machines/bank-request.ts; decisions 206 and 210):
// the machine is restored at the bank's stored state, takes the request, waits for Plaid, and says where the bank
// lands. Nothing here writes the bank's row: the caller saves the landing through src/plaid/item-store.ts.
import { createEffectActor, send, waitFor } from "@xstate/effect";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
	type BankOutcome,
	bankRequestMachine,
	type LiveBankState,
	type PlaidBank,
	PlaidRefused,
} from "../machines/bank-request";
import {
	getItem,
	type PlaidEnv,
	type PlaidFailure,
	removeItem,
} from "./client";
import type { ConnectionState } from "./item-store";
import { decryptToken } from "./token-crypto";

/** How long a request waits for Plaid before it gives up, which leaves the bank as it was. */
const PLAID_WAIT = "25 seconds";

/**
 * Where a request leaves the bank: the state it lands in, and whether Plaid agreed. A bank that is already
 * disconnected takes no request, so it stays disconnected with the outcome still "waiting".
 */
export const askBank = (
	from: ConnectionState,
	request: "FIX" | "DISCONNECT",
): Effect.Effect<
	{ state: ConnectionState; outcome: BankOutcome },
	never,
	PlaidBank
> =>
	from === "disconnected"
		? Effect.succeed({ state: from, outcome: "waiting" })
		: Effect.gen(function* () {
				const actor = yield* createEffectActor(bankRequestMachine, {
					input: { from },
					snapshot: bankRequestMachine.getPersistedSnapshot(
						bankRequestMachine.resolveState({
							value: from,
							context: { from, outcome: "waiting" },
						}),
					),
				});

				yield* send(actor, { type: request });

				const landed = yield* waitFor(
					actor,
					(snapshot) => snapshot.context.outcome !== "waiting",
					{ timeout: PLAID_WAIT },
				);

				return {
					state: landedState(String(landed.value), from),
					outcome: landed.context.outcome,
				};
			}).pipe(
				Effect.scoped,
				// No answer in time is Plaid not agreeing: the bank stays as it was.
				Effect.catch(() =>
					Effect.succeed({ state: from, outcome: "plaid_refused" as const }),
				),
			);

const LANDINGS: readonly ConnectionState[] = [
	"ok",
	"login_broken",
	"needs_relink",
	"login_broken_and_needs_relink",
	"disconnected",
];

/** The machine's state as a bank's state. A waiting state is never where a finished request lands, so it reads as `from`. */
const landedState = (value: string, from: LiveBankState): ConnectionState =>
	LANDINGS.find((state) => state === value) ?? from;

/** What Plaid's refusal may log: its request id, never a token (CLAUDE.md). */
function logRequestId(cause: PlaidFailure | PlaidRefused) {
	if (Predicate.isTagged(cause, "PlaidRefusal") && cause.request_id)
		console.error("Plaid request failed", { request_id: cause.request_id });
}

/**
 * Plaid, for one bank whose stored token the caller read. The login works when Plaid's item carries no error. Letting
 * go succeeds when Plaid removes the bank, and also when Plaid no longer knows it (ITEM_NOT_FOUND), so a retry after a
 * half-finished disconnect finishes.
 */
export const plaidBankFor = (
	env: PlaidEnv,
	item: { access_token_encrypted: ArrayBuffer },
): PlaidBank["Service"] => {
	const token = Effect.tryPromise({
		try: () =>
			decryptToken(item.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY ?? ""),
		catch: () => new PlaidRefused(),
	});

	const refused = (cause: PlaidFailure | PlaidRefused) => {
		logRequestId(cause);

		return Effect.fail(new PlaidRefused());
	};

	return {
		loginWorks: token.pipe(
			Effect.flatMap((accessToken) => getItem(env, accessToken)),
			Effect.catch(refused),
			Effect.flatMap((result) =>
				result.item.error ? Effect.fail(new PlaidRefused()) : Effect.void,
			),
		),
		letGo: token.pipe(
			Effect.flatMap((accessToken) => removeItem(env, accessToken)),
			Effect.asVoid,
			Effect.catch((cause) =>
				Predicate.isTagged(cause, "PlaidRefusal") &&
				cause.error_code === "ITEM_NOT_FOUND"
					? Effect.void
					: refused(cause),
			),
		),
	};
};
