import { setup } from "xstate";

// The state of one bank connection (a plaid_items row). The store in src/plaid/item-store.ts derives the state from
// the row's status and its two attention flags, asks this machine, through next(), what an event does, and writes
// the flags for the state it lands in. Decision 173 says what each state means for the flags.
//
// The events, in plain words:
//   LOGIN_BROKEN     Plaid says the bank's login needs signing in again.
//   EXPIRY_WARNING   Plaid warns that the login will expire soon (PENDING_EXPIRATION or PENDING_DISCONNECT).
//   SYNC_SUCCEEDED   a sync got every page while it held the sync lease: the login works.
//   RELINKED         the person fixed the login (Fix connection, which opens Plaid Link in update mode).
//   DISCONNECT       the person disconnected the bank.
//
// The grid: the row is the state now, the column is the event, and the cell is where the bank goes. A cell that
// says "same" is the state it is already in.
//
//                              LOGIN_BROKEN                EXPIRY_WARNING              SYNC_SUCCEEDED   RELINKED   DISCONNECT
//   ok                         login_broken                expiring                    ok               ok         disconnected
//   login_broken               login_broken                login_broken_and_expiring   ok               ok         disconnected
//   expiring                   login_broken_and_expiring   expiring                    expiring         ok         disconnected
//   login_broken_and_expiring  login_broken_and_expiring   login_broken_and_expiring    expiring         ok         disconnected
//   disconnected               refused                     refused                     refused          refused    refused
//
// The states, in plain words:
//   ok                         the bank works.
//   login_broken               Plaid says the login is broken. A good sync clears it (the bank works again).
//   expiring                   Plaid warns the login will expire. A good sync does not clear it: only a relink does.
//   login_broken_and_expiring   both. A good sync clears the login problem, and the bank is then expiring.
//   disconnected               the bank was removed. This state is final: no event moves it, and its token is gone.
//
// Each flagged state is a row that needs attention; the reminder email and Fix connection follow from that.
export const plaidConnectionMachine = setup({}).createMachine({
	id: "plaidConnection",
	initial: "ok",
	states: {
		ok: {
			on: {
				LOGIN_BROKEN: { target: "login_broken" },
				EXPIRY_WARNING: { target: "expiring" },
				SYNC_SUCCEEDED: { target: "ok" },
				RELINKED: { target: "ok" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		login_broken: {
			on: {
				LOGIN_BROKEN: { target: "login_broken" },
				EXPIRY_WARNING: { target: "login_broken_and_expiring" },
				SYNC_SUCCEEDED: { target: "ok" },
				RELINKED: { target: "ok" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		expiring: {
			on: {
				LOGIN_BROKEN: { target: "login_broken_and_expiring" },
				EXPIRY_WARNING: { target: "expiring" },
				SYNC_SUCCEEDED: { target: "expiring" },
				RELINKED: { target: "ok" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		login_broken_and_expiring: {
			on: {
				LOGIN_BROKEN: { target: "login_broken_and_expiring" },
				EXPIRY_WARNING: { target: "login_broken_and_expiring" },
				SYNC_SUCCEEDED: { target: "expiring" },
				RELINKED: { target: "ok" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		disconnected: { type: "final" },
	},
});
