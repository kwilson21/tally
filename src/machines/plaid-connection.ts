import { setup } from "xstate";

// The state of one bank connection (a plaid_items row). The store in src/plaid/item-store.ts asks this
// machine, through next(), what an event does; every write to the row then follows that answer.
//
// The events, in plain words:
//   LOGIN_BROKEN    Plaid says the bank's login needs signing in again.
//   RELINKED        the person fixed the login (Fix connection, which opens Plaid Link in update mode).
//   SYNC_SUCCEEDED  a sync got every page of the bank's history while it held the sync lease.
//   DISCONNECT      the person disconnected the bank.
//
// The grid: the row is the state now, the column is the event, and the cell is where the bank goes.
//
//                       LOGIN_BROKEN       RELINKED   SYNC_SUCCEEDED   DISCONNECT
//   ok                  needs_attention    ok         ok               disconnected
//   needs_attention     needs_attention    ok         ok               disconnected
//   disconnected        refused            refused    refused          refused
//
// The states, in plain words:
//   ok              the bank works and Tally syncs it.
//   needs_attention Plaid says the login is broken: Accounts shows Fix connection and a reminder email may go out.
//   disconnected    the bank was removed. This state is final: no event moves it, and its token is gone.
//
// Writing ok clears the reminder email's timestamp too (decision 173). This machine only says where a bank
// goes; the store does the write.
export const plaidConnectionMachine = setup({}).createMachine({
	id: "plaidConnection",
	initial: "ok",
	states: {
		ok: {
			on: {
				LOGIN_BROKEN: { target: "needs_attention" },
				RELINKED: { target: "ok" },
				SYNC_SUCCEEDED: { target: "ok" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		needs_attention: {
			on: {
				LOGIN_BROKEN: { target: "needs_attention" },
				RELINKED: { target: "ok" },
				SYNC_SUCCEEDED: { target: "ok" },
				DISCONNECT: { target: "disconnected" },
			},
		},
		disconnected: { type: "final" },
	},
});
