// One sentence per machine in the catalog's MachineDiagram specimen, saying what the machine is for.
// The catalog shows each one above its picture, so a reader who does not know the system can follow it.
export const MACHINE_PURPOSE = {
	category:
		'When Jev finds three or more purchases it could not sort and a usable name comes back for them (say "Pet Care"), Tally suggests a new category. A person makes it or says no. If no usable name comes back, or no purchase backs the suggestion any more, it quietly goes away.',
	name: 'Tally suggests a plain name for a store whose text on the statement is cryptic ("AMZN Mktp US*2K4" becomes "Amazon"), from the bank or a guess. A person picks one, types their own, or keeps the bank\'s text. A suggestion that goes stale is withdrawn.',
	sortingTurn:
		"Sorting asks Jev about the household's transactions in groups. Only one group at a time may ask, so two runs never ask about the same transaction. A group takes the turn for 15 minutes and gives it back when it saves; if it never does, the time runs out and another group can take it.",
} as const;
