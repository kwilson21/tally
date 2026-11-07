import { describe, expect, it } from "vitest";
import { next } from "../src/machines/next";
import { plaidConnectionMachine } from "../src/machines/plaid-connection";

// Every state x event pair, walked against the machine. A legal pair names where it goes; every other pair is refused.
const STATES = [
	"ok",
	"login_broken",
	"expiring",
	"login_broken_and_expiring",
	"disconnected",
] as const;
const EVENTS = [
	"LOGIN_BROKEN",
	"EXPIRY_WARNING",
	"SYNC_SUCCEEDED",
	"RELINKED",
	"DISCONNECT",
] as const;

const LEGAL: Partial<Record<string, Partial<Record<string, string>>>> = {
	ok: {
		LOGIN_BROKEN: "login_broken",
		EXPIRY_WARNING: "expiring",
		SYNC_SUCCEEDED: "ok",
		RELINKED: "ok",
		DISCONNECT: "disconnected",
	},
	login_broken: {
		LOGIN_BROKEN: "login_broken",
		EXPIRY_WARNING: "login_broken_and_expiring",
		// A good sync clears a login problem, and nothing else.
		SYNC_SUCCEEDED: "ok",
		RELINKED: "ok",
		DISCONNECT: "disconnected",
	},
	expiring: {
		LOGIN_BROKEN: "login_broken_and_expiring",
		EXPIRY_WARNING: "expiring",
		// A good sync does not clear an expiry warning: only a relink does.
		SYNC_SUCCEEDED: "expiring",
		RELINKED: "ok",
		DISCONNECT: "disconnected",
	},
	login_broken_and_expiring: {
		LOGIN_BROKEN: "login_broken_and_expiring",
		EXPIRY_WARNING: "login_broken_and_expiring",
		SYNC_SUCCEEDED: "expiring",
		RELINKED: "ok",
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

	it("has exactly the five states, with disconnected final", () => {
		const states = plaidConnectionMachine.config.states ?? {};
		expect(Object.keys(states).sort()).toEqual([...STATES].sort());
		expect(states.disconnected).toMatchObject({ type: "final" });
	});
});
