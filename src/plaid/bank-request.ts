// Runs one request about a bank through the bridged machine (src/machines/bank-request.ts; decisions 206 and 210):
// the machine is restored at the bank's stored state, takes the request, waits for Plaid, and says where the bank
// lands. Nothing here writes the bank's row: the caller saves the landing through src/plaid/item-store.ts.
import { createEffectActor, send, waitFor } from "@xstate/effect";
import * as Duration from "effect/Duration";
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
	TIMEOUT,
} from "./client";
import type { ConnectionState } from "./item-store";
import { decryptToken } from "./token-crypto";

/** How long a request waits for Plaid before it gives up, which leaves the bank as it was. */
const PLAID_WAIT = "25 seconds";

/**
 * How long the login check waits: the Plaid client's own timeout plus a margin. The client gives up first, so a
 * late answer is the client's to judge (it is taken up to its timeout, as the check always took it), and the margin
 * keeps this wait from racing it.
 */
export const LOGIN_CHECK_WAIT = Duration.sum(
	Duration.fromInputUnsafe(TIMEOUT),
	Duration.fromInputUnsafe("5 seconds"),
);

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

/**
 * Asks Plaid whether a bank's login still fails, for the sync after a login error and for the Plaid webhook (#1192).
 * Resolves true when it still fails: Plaid reports the problem, cannot be reached or refuses, answers too late, or
 * the wait ends. Resolves false only when Plaid says the login works.
 *
 * The machine starts at "ok" with `from` "ok". The check never lands the bank (it is written by the caller, through
 * the item store), so the bank's own state is not needed. A disconnected bank is asked as well, as it always was:
 * askBank's short cut for a disconnected bank is not used here.
 */
export const askLoginStillBroken = (
	wait: Duration.Input,
): Effect.Effect<boolean /* still broken */, never, PlaidBank> =>
	Effect.gen(function* () {
		const actor = yield* createEffectActor(bankRequestMachine, {
			input: { from: "ok" },
		});

		yield* send(actor, { type: "LOGIN_ERROR" });

		const landed = yield* waitFor(
			actor,
			(snapshot) => snapshot.context.outcome !== "waiting",
			{ timeout: wait },
		);

		return landed.context.outcome !== "done";
	}).pipe(
		Effect.scoped,
		// No answer in time: the login is still broken, as it is when Plaid cannot be asked.
		Effect.catch(() => Effect.succeed(true)),
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
 * half-finished disconnect finishes. `fetchImpl` is the transport (the sync and the tests inject theirs).
 *
 * `loginCheck` is the login check's reading (decision 245), and changes two things and nothing else. Its login is still
 * broken unless Plaid's `error` field is null, so an item with no `error` field at all counts as broken (Fix connection
 * reads any truthy error as broken, and a missing field as working). A refusal logs nothing, as the check never has.
 */
export const plaidBankFor = (
	env: PlaidEnv,
	item: {
		access_token_encrypted: ArrayBuffer | Uint8Array | readonly number[];
	},
	options: { fetchImpl?: typeof fetch; loginCheck?: boolean } = {},
): PlaidBank["Service"] => {
	const token = Effect.tryPromise({
		try: () =>
			decryptToken(item.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY ?? ""),
		catch: () => new PlaidRefused(),
	});

	const refused = (cause: PlaidFailure | PlaidRefused) => {
		if (!options.loginCheck) logRequestId(cause);

		return Effect.fail(new PlaidRefused());
	};

	return {
		loginWorks: token.pipe(
			Effect.flatMap((accessToken) =>
				getItem(env, accessToken, options.fetchImpl),
			),
			Effect.catch(refused),
			Effect.flatMap((result) => {
				const problem = options.loginCheck
					? result.item.error !== null
					: Boolean(result.item.error);

				return problem ? Effect.fail(new PlaidRefused()) : Effect.void;
			}),
		),
		letGo: token.pipe(
			Effect.flatMap((accessToken) =>
				removeItem(env, accessToken, options.fetchImpl),
			),
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
