import { setup } from "xstate";

// The state of one bank connection (a plaid_items row). The store in src/plaid/item-store.ts derives the state from
// the row's status and its two attention flags, asks this machine, through next(), what an event does, and writes
// the flags for the state it lands in. Decision 173 says what each state means for the flags.
//
// The events, in plain words:
//   LOGIN_BROKEN     Plaid says the bank's login needs signing in again (an ITEM login error).
//   RELINK_NEEDED    Plaid says the bank needs a relink: its login will expire (PENDING_EXPIRATION or PENDING_DISCONNECT),
//                    or the person revoked its permission (USER_PERMISSION_REVOKED). Only a relink fixes these.
//   SYNC_SUCCEEDED   a sync got every page while it held the sync lease: the login works.
//   RELINKED         the person fixed the bank (Fix connection, which opens Plaid Link in update mode).
//   DISCONNECT       the person disconnected the bank.
//
// The grid: the row is the state now, the column is the event, and the cell is where the bank goes.
//
//                              LOGIN_BROKEN                    RELINK_NEEDED                     SYNC_SUCCEEDED   RELINKED   DISCONNECT
//   ok                         login_broken                    needs_relink                      ok               ok         disconnected
//   login_broken               login_broken                    login_broken_and_needs_relink     ok               ok         disconnected
//   needs_relink               login_broken_and_needs_relink   needs_relink                      needs_relink     ok         disconnected
//   login_broken_and_needs_relink  login_broken_and_needs_relink  login_broken_and_needs_relink  needs_relink     ok         disconnected
//   disconnected               refused                         refused                           refused          refused    refused
//
// The states, in plain words:
//   ok                             the bank works.
//   login_broken                   Plaid says the login is broken. A good sync clears it (the bank works again).
//   needs_relink                   the bank needs a relink. A good sync does not clear it: only a relink does.
//   login_broken_and_needs_relink both. A good sync clears the login problem, and the bank is then needs_relink.
//   disconnected                   the bank was removed. This state is final: no event moves it, and its token is gone.
//
// Each flagged state is a row that needs attention; the reminder email and Fix connection follow from that.
export const plaidConnectionMachine = setup({}).createMachine({
	id: "plaidConnection",
	initial: "ok",
	states: {
		ok: {
			description: "The bank works.",
			on: {
				LOGIN_BROKEN: {
					target: "login_broken",
					description: "Plaid says the bank's login needs signing in again.",
				},
				RELINK_NEEDED: {
					target: "needs_relink",
					description:
						"Plaid says the bank needs a relink, because its login will expire or the person took back its permission.",
				},
				SYNC_SUCCEEDED: {
					target: "ok",
					description: "A sync got every page, so the login works.",
				},
				RELINKED: {
					target: "ok",
					description: "The person fixed the bank with Fix connection.",
				},
				DISCONNECT: {
					target: "disconnected",
					description: "The person disconnected the bank.",
				},
			},
		},
		login_broken: {
			description: "Plaid says the login is broken, and a good sync clears it.",
			on: {
				LOGIN_BROKEN: {
					target: "login_broken",
					description: "Plaid says the login is still broken.",
				},
				RELINK_NEEDED: {
					target: "login_broken_and_needs_relink",
					description:
						"Plaid says the bank now needs a relink, on top of the broken login.",
				},
				SYNC_SUCCEEDED: {
					target: "ok",
					description: "A sync got every page, so the login works again.",
				},
				RELINKED: {
					target: "ok",
					description: "The person fixed the bank with Fix connection.",
				},
				DISCONNECT: {
					target: "disconnected",
					description: "The person disconnected the bank.",
				},
			},
		},
		needs_relink: {
			description:
				"The bank needs a relink, which a good sync does not clear: only a relink does.",
			on: {
				LOGIN_BROKEN: {
					target: "login_broken_and_needs_relink",
					description: "Plaid says the login is broken as well.",
				},
				RELINK_NEEDED: {
					target: "needs_relink",
					description: "Plaid says the bank needs a relink again.",
				},
				SYNC_SUCCEEDED: {
					target: "needs_relink",
					description:
						"A sync got every page, but only a relink clears this, so the bank still needs one.",
				},
				RELINKED: {
					target: "ok",
					description: "The person fixed the bank with Fix connection.",
				},
				DISCONNECT: {
					target: "disconnected",
					description: "The person disconnected the bank.",
				},
			},
		},
		login_broken_and_needs_relink: {
			description:
				"The login is broken and the bank needs a relink, and a good sync clears only the login.",
			on: {
				LOGIN_BROKEN: {
					target: "login_broken_and_needs_relink",
					description: "Plaid says the login is broken again.",
				},
				RELINK_NEEDED: {
					target: "login_broken_and_needs_relink",
					description: "Plaid says the bank needs a relink again.",
				},
				SYNC_SUCCEEDED: {
					target: "needs_relink",
					description:
						"A sync got every page, so the login works, but the bank still needs a relink.",
				},
				RELINKED: {
					target: "ok",
					description: "The person fixed the bank with Fix connection.",
				},
				DISCONNECT: {
					target: "disconnected",
					description: "The person disconnected the bank.",
				},
			},
		},
		disconnected: {
			type: "final",
			description:
				"The bank was removed, its token is gone, and nothing moves it.",
		},
	},
});

// The plain name of each state, for the diagrams and tables that show this machine.
export const PLAID_CONNECTION_LABELS: Record<
	keyof typeof plaidConnectionMachine.states,
	string
> = {
	ok: "Working",
	login_broken: "Login broken",
	needs_relink: "Needs reconnecting",
	login_broken_and_needs_relink: "Login broken and needs reconnecting",
	disconnected: "Disconnected",
};
