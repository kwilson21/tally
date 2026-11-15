// One sentence per machine in the catalog's MachineDiagram specimen, saying what the machine is for.
// The catalog shows each one above its picture, so a reader who does not know the system can follow it.
export const MACHINE_PURPOSE = {
	category:
		'When Jev finds three or more purchases it could not sort and a usable name comes back for them (say "Pet Care"), Tally suggests a new category. A person makes it or says no. If no usable name comes back, or no purchase backs the suggestion any more, it quietly goes away.',
	feedbackFiling:
		"Each feedback message is filed once as a GitHub issue, and gets up to five tries. A try holds the message for 10 minutes; a failed or cut-off try makes it ready again until the fifth, and a message GitHub rejects gives up at once. A refused token gives its try back.",
	name: 'Tally suggests a plain name for a store whose text on the statement is cryptic ("AMZN Mktp US*2K4" becomes "Amazon"), from the bank or a guess. A person picks one, types their own, or keeps the bank\'s text. A suggestion that goes stale is withdrawn.',
	plaidLease:
		"Before a bank is read, its sync takes the bank's lease, so two syncs never read the same bank at once. A sync gives the lease back when it finishes; if a sync is cut off, the lease runs out by itself when its time passes, and the next sync may take it. Once a bank is disconnected, nothing may take it or write to it again.",
	readyClaim:
		'Before a "ready" email goes out, its address is claimed, so two runs never send it at once. If a run is cut off after claiming, the email it wrote is kept, and a later run sends that same email again once the claim is 10 minutes old. An address is done once the email is delivered, or once a kept email is over 23 hours old and is dropped.',
	sortingTurn:
		"Sorting asks Jev about the household's transactions in groups. Only one group at a time may ask, so two runs never ask about the same transaction. A group takes the turn for 15 minutes and gives it back when it saves; if it never does, the time runs out and another group can take it.",
} as const;
