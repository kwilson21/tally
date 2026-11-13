// The accounts area's rules in style 3 (decisions 187, 206 and 210): link a bank, sync now, the Apple Card upload and
// its removal, and the presence check-in. The two requests that wait for Plaid before a bank's state can move (Fix
// connection and Disconnect) are the bridged machine in src/machines/bank-request.ts. Each rule here takes a typed
// request and what is stored, and is written as a list of its parts (`rule`, in ./terms). The time and the person are
// inputs (decision 195), and nothing here parses, reads a clock, calls Plaid or touches the database.
import * as Data from "effect/Data";
import { HOME_SEEN_EVERY_MS } from "../first-tally/home-seen";
import { rule, term, unless } from "./terms";

// Link a bank. Plaid has already exchanged the token when this is asked; the rule says what Tally stores.

export type LinkBankRequest = {
	institution: string;
	plaidItemId: string;
	who: string;
	/** The household's date (YYYY-MM-DD) the bank stroke is drawn on. */
	today: string;
};

export type LinkBankFacts = {
	/** Whether the first week's setup is still to do. */
	settingUp: boolean;
};

/** What linking saves, and what it says: a bank linked during setup says Tally is reading its history. */
export type LinkBankWrite = LinkBankRequest & { announceReading: boolean };

export const linkBank = rule({
	name: "Link a bank",
	given: (request: LinkBankRequest, facts: LinkBankFacts) => ({
		...request,
		...facts,
	}),
	refusals: [],
	writes: (g): LinkBankWrite => ({
		institution: g.institution,
		plaidItemId: g.plaidItemId,
		who: g.who,
		today: g.today,
		announceReading: g.settingUp,
	}),
	writesText:
		"Stores the bank with its token, draws the bank stroke on the household's day, and takes the setup questions back so the new bank's deposits and charges are asked.",
});

// Sync now.

/** What Sync now saves is nothing of its own: it lets the sync run. */
export type SyncNowWrite = { sync: true };

/**
 * Sync now refuses nothing. With no working bank it still runs, because the run also applies the household's merchant
 * rules to what is already stored; what it then says ("Fix the connection first.") is the page's reading of the result.
 * How often a bank may sync is the sync engine's own limit.
 */
export const syncNow = rule({
	name: "Sync every bank now",
	given: (_request: Record<never, never>, _facts: null) => ({}),
	refusals: [],
	writes: (): SyncNowWrite => ({ sync: true }),
	writesText:
		"Syncs every bank whose connection works, each at most once a minute, and applies the merchant rules to what is stored.",
});

// Apple Card.

/** What the edge read from an upload: the file's rows or the sentence that refuses it, and the same for the balance. */
export type UploadRequest<Row> = {
	file: { rows: Row[] } | { error: string };
	/** A balance left blank is read as no balance (null), which is allowed. */
	balance: { cents: number | null } | { error: string };
	who: string;
	today: string;
};

/** The page shows the edge's own sentences for the file and the balance, both at once. */
export class UploadRefused extends Data.TaggedError("UploadRefused") {
	readonly say = "Check the file and the balance.";
}

export type UploadWrite<Row> = {
	rows: Row[];
	/** Null when the balance was left blank: the rows are stored and the balance is left as it is. */
	balanceCents: number | null;
	who: string;
	today: string;
};

/** Built for the rows as the CSV reader gives them. */
export const uploadAppleCard = <Row>() =>
	rule({
		name: "Upload an Apple Card statement",
		given: (request: UploadRequest<Row>, _facts: null) => request,
		refusals: [
			unless(
				term<UploadRequest<Row>>(
					"the file is Apple's CSV and the balance is a dollar amount or blank",
					(g) => "rows" in g.file && "cents" in g.balance,
				),
				() => new UploadRefused(),
			),
		],
		writes: (g): UploadWrite<Row> => ({
			// The refusal above answered a file or a balance that was not read, so the empty list and this null are never used.
			rows: "rows" in g.file ? g.file.rows : [],
			balanceCents: "cents" in g.balance ? g.balance.cents : null,
			who: g.who,
			today: g.today,
		}),
		writesText:
			"Stores the statement's rows that are new, with the balance as of today. The import decides which rows are new.",
	});

export type RemoveCardFacts = {
	/** The Apple Card as stored, or null when there is none. */
	card: { removed: boolean } | null;
};

export type RemoveCardWrite = { deleteHistory: boolean };

export const removeAppleCard = rule({
	name: "Remove Apple Card",
	given: (request: { deleteHistory: boolean }, facts: RemoveCardFacts) => ({
		...request,
		...facts,
	}),
	nothingToDoIf: term<RemoveCardFacts>(
		"there is no Apple Card, or it is already removed",
		(g) => g.card === null || g.card.removed,
	),
	refusals: [],
	writes: (g): RemoveCardWrite => ({ deleteHistory: g.deleteHistory }),
	writesText:
		"Marks the card removed and clears its balance, or, when the person asks, deletes the card with its transactions and balances.",
});

// The presence check-in (decision 146).

export type CheckInFacts = {
	/** Whether the person is a member of the household now (not removed). */
	member: boolean;
	/** When their last check-in was written (ms), or null when there is none. */
	lastSeenMs: number | null;
};

export type CheckInWrite = { member: string; now: number };

type CheckInGiven = CheckInWrite & {
	isMember: boolean;
	lastSeenMs: number | null;
};

export const checkIn = rule({
	name: "Say a person is still on the setup page",
	given: (
		request: { member: string; now: number },
		facts: CheckInFacts,
	): CheckInGiven => ({
		...request,
		isMember: facts.member,
		lastSeenMs: facts.lastSeenMs,
	}),
	nothingToDoIf: term<CheckInGiven>(
		"the person is not a member, or their last check-in is less than 30 seconds old",
		(g) =>
			!g.isMember ||
			(g.lastSeenMs !== null && g.now - g.lastSeenMs < HOME_SEEN_EVERY_MS),
	),
	refusals: [],
	writes: (g): CheckInWrite => ({ member: g.member, now: g.now }),
	writesText: "Writes the time of the check-in on the person's own row.",
});
