import { describe, expect, it } from "vitest";
import { next } from "../src/machines/next";
import { plaidConnectionMachine } from "../src/machines/plaid-connection";

// Every state x event pair, walked against the machine. A legal pair names where it goes; every other pair is refused.
const STATES = ["ok", "needs_attention", "disconnected"] as const;
const EVENTS = [
	"LOGIN_BROKEN",
	"RELINKED",
	"SYNC_SUCCEEDED",
	"DISCONNECT",
] as const;

const LEGAL: Partial<Record<string, Partial<Record<string, string>>>> = {
	ok: {
		LOGIN_BROKEN: "needs_attention",
		RELINKED: "ok",
		SYNC_SUCCEEDED: "ok",
		DISCONNECT: "disconnected",
	},
	needs_attention: {
		LOGIN_BROKEN: "needs_attention",
		RELINKED: "ok",
		SYNC_SUCCEEDED: "ok",
		DISCONNECT: "disconnected",
	},
	// Final: nothing moves a disconnected bank.
	disconnected: {},
};

describe("plaid connection machine", () => {
	for (const state of STATES) {
		for (const event of EVENTS) {
			const expected = LEGAL[state]?.[event] ?? null;
			it(`${state} + ${event} -> ${expected ?? "refused"}`, () => {
				expect(next(plaidConnectionMachine, state, event)).toBe(expected);
			});
		}
	}

	it("has exactly the three states, with disconnected final", () => {
		const states = plaidConnectionMachine.config.states ?? {};
		expect(Object.keys(states).sort()).toEqual([
			"disconnected",
			"needs_attention",
			"ok",
		]);
	});
});
