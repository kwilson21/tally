import { createEffectLogic, setupEffect } from "@xstate/effect";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A person's request about one bank that has to wait for Plaid before the bank's state can move (decision 206, style
// 2: the XState and Effect bridge; decision 210). It has the bank connection's own states
// (src/machines/plaid-connection.ts), plus one waiting state for each request:
//
//   FIX         the person says they fixed the bank. Tally asks Plaid whether the login works now. If it does, the bank
//               is ok; if Plaid still reports a problem, or cannot be reached, the bank stays as it was.
//   DISCONNECT  the person disconnects the bank. Tally asks Plaid to let the bank go. Once Plaid has, the bank is
//               disconnected; if Plaid refuses or cannot be reached, the bank stays as it was.
//   LOGIN_ERROR a login error came from the sync or the Plaid webhook. Tally asks Plaid whether the login still fails.
//               The bank never moves: "done" means the login works, and "plaid_refused" means it is still broken. This
//               is the OPPOSITE of FIX, where "plaid_refused" leaves the bank as it was: here a bank Plaid cannot confirm
//               counts as still broken (src/plaid/bank-request.ts, askLoginStillBroken).
//
// A disconnected bank takes neither request: that state is final. The machine decides only where the bank lands. The
// row is written by src/plaid/item-store.ts, which asks the connection machine through next(), as every other write
// of a bank's state does.

/** Plaid refused, reported a problem, or could not be reached. It carries nothing: what Plaid answered is logged where it is asked. */
export class PlaidRefused extends Data.TaggedError("PlaidRefused") {}

/** The two things a request asks Plaid, for the bank the request is about. */
export class PlaidBank extends Context.Service<
	PlaidBank,
	{
		/** Succeeds when Plaid reports no problem with the bank's login. */
		readonly loginWorks: Effect.Effect<void, PlaidRefused>;
		/** Succeeds once Plaid has let the bank go, or already had. */
		readonly letGo: Effect.Effect<void, PlaidRefused>;
	}
>()("tally/plaid/PlaidBank") {}

const LIVE = Schema.Literals([
	"ok",
	"login_broken",
	"needs_relink",
	"login_broken_and_needs_relink",
]);

/** A bank's state while it is still connected. */
export type LiveBankState = typeof LIVE.Type;

/** How a request ended: Plaid agreed, Plaid did not, or the bank took no request (it is disconnected). */
export type BankOutcome = "waiting" | "done" | "plaid_refused";

/** A request starts by waiting for Plaid. */
const WAITING: BankOutcome = "waiting";

/** What every connected state does with the two requests. */
const REQUESTS = {
	FIX: { target: "asking_plaid_about_the_login" },
	DISCONNECT: { target: "asking_plaid_to_let_go" },
	LOGIN_ERROR: { target: "asking_plaid_whether_the_login_is_still_broken" },
} as const;

export const bankRequestMachine = setupEffect({
	schemas: { input: Schema.Struct({ from: LIVE }) },
	actors: {
		loginWorks: createEffectLogic({
			effect: () => PlaidBank.use((plaid) => plaid.loginWorks),
		}),
		letGo: createEffectLogic({
			effect: () => PlaidBank.use((plaid) => plaid.letGo),
		}),
	},
}).createMachine({
	id: "bankRequest",
	context: ({ input }) => ({
		/** The state the bank was in when the request arrived, which it goes back to when Plaid does not agree. */
		from: input.from,
		outcome: WAITING,
	}),
	initial: "ok",
	states: {
		ok: { on: REQUESTS },
		login_broken: { on: REQUESTS },
		needs_relink: { on: REQUESTS },
		login_broken_and_needs_relink: { on: REQUESTS },
		asking_plaid_about_the_login: {
			invoke: {
				src: "loginWorks",
				onDone: ({ context }) => ({
					target: "ok",
					context: { ...context, outcome: "done" },
				}),
				// Back to the state the bank was in.
				onError: ({ context }) => ({
					target: context.from,
					context: { ...context, outcome: "plaid_refused" },
				}),
			},
		},
		asking_plaid_to_let_go: {
			invoke: {
				src: "letGo",
				onDone: ({ context }) => ({
					target: "disconnected",
					context: { ...context, outcome: "done" },
				}),
				onError: ({ context }) => ({
					target: context.from,
					context: { ...context, outcome: "plaid_refused" },
				}),
			},
		},
		// The login check. The bank never moves, so this state goes back to where it started (the caller starts the
		// machine at "ok" with from "ok", as the check does not depend on the bank's state). Unlike FIX, Plaid refusing
		// is "plaid_refused", which the caller reads as still broken.
		asking_plaid_whether_the_login_is_still_broken: {
			invoke: {
				src: "loginWorks",
				onDone: ({ context }) => ({
					target: context.from,
					context: { ...context, outcome: "done" },
				}),
				onError: ({ context }) => ({
					target: context.from,
					context: { ...context, outcome: "plaid_refused" },
				}),
			},
		},
		disconnected: { type: "final" },
	},
});
