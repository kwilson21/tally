// The read, decide and save loop every converted area shares (decision 190). The rule decides in TypeScript; the save's
// guard raises an error when what the rule read has changed since, and this asks again on fresh facts.
import type { Outcome } from "../rules/rule";

/**
 * Reads, decides and saves. `decide` reads the facts and asks the rule; a write is saved with `save`. When the guard
 * raises (`changedSinceRead` knows its error: another writer changed the facts between the read and the save), it reads
 * and decides again, three times in all, so two taps at once both count. It then gives up with the `gaveUp` error; any
 * other failure is passed on at once. `saved` is what `save` answered, and is there only for a write.
 */
export async function decideAndSaveWith<W, S>(steps: {
	decide: () => Promise<Outcome<W>>;
	save: (what: W) => Promise<S>;
	changedSinceRead: (error: Error) => boolean;
	gaveUp: string;
}): Promise<{ outcome: Outcome<W>; saved?: S }> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const outcome = await steps.decide();

		if (outcome.kind !== "write") return { outcome };

		try {
			return { outcome, saved: await steps.save(outcome.write) };
		} catch (error) {
			if (!(error instanceof Error && steps.changedSinceRead(error)))
				throw error;
		}
	}

	throw new Error(steps.gaveUp);
}
