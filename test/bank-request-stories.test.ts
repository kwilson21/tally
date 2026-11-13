import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	bankRequestMachine,
	PlaidBank,
	PlaidRefused,
} from "../src/machines/bank-request";
import { askBank } from "../src/plaid/bank-request";
import type { ConnectionState } from "../src/plaid/item-store";

// The bank requests as stories (decisions 187, 206 style 2, 210): each row is the state the bank was in, what the
// person asked, what Plaid answered, and where the bank lands. Plaid here is a stand-in; nothing touches a database.

type Plaid = "agrees" | "refuses";

/** Runs a request against a stand-in Plaid, and says what Plaid was asked. */
async function ask(
	from: ConnectionState,
	request: "FIX" | "DISCONNECT",
	plaid: Plaid,
) {
	const asked: string[] = [];

	const answer = (what: string) =>
		Effect.suspend(() => {
			asked.push(what);

			return plaid === "agrees" ? Effect.void : Effect.fail(new PlaidRefused());
		});

	const landed = await Effect.runPromise(
		askBank(from, request).pipe(
			Effect.provideService(PlaidBank, {
				loginWorks: answer("login"),
				letGo: answer("let go"),
			}),
		),
	);

	return { ...landed, asked };
}

const LIVE = [
	"ok",
	"login_broken",
	"needs_relink",
	"login_broken_and_needs_relink",
] as const;

describe("Fix connection", () => {
	it.each(LIVE)(
		"a %s bank is ok once Plaid says the login works",
		async (from) => {
			expect(await ask(from, "FIX", "agrees")).toEqual({
				state: "ok",
				outcome: "done",
				asked: ["login"],
			});
		},
	);

	it.each(LIVE)(
		"a %s bank stays as it was when Plaid still reports a problem",
		async (from) => {
			expect(await ask(from, "FIX", "refuses")).toEqual({
				state: from,
				outcome: "plaid_refused",
				asked: ["login"],
			});
		},
	);
});

describe("Disconnect a bank", () => {
	it.each(LIVE)(
		"a %s bank is disconnected once Plaid has let it go",
		async (from) => {
			expect(await ask(from, "DISCONNECT", "agrees")).toEqual({
				state: "disconnected",
				outcome: "done",
				asked: ["let go"],
			});
		},
	);

	it.each(LIVE)(
		"a %s bank stays as it was when Plaid does not let it go",
		async (from) => {
			expect(await ask(from, "DISCONNECT", "refuses")).toEqual({
				state: from,
				outcome: "plaid_refused",
				asked: ["let go"],
			});
		},
	);
});

describe("a disconnected bank", () => {
	it.each(["FIX", "DISCONNECT"] as const)(
		"takes no %s, and Plaid is not asked",
		async (request) => {
			expect(await ask("disconnected", request, "agrees")).toEqual({
				state: "disconnected",
				outcome: "waiting",
				asked: [],
			});
		},
	);

	it("is the machine's final state", () => {
		expect(bankRequestMachine.config.states?.disconnected).toEqual({
			type: "final",
		});
	});
});
