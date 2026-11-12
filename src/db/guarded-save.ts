// The read, decide and save loop every converted area shares (decisions 190 and 206). The rule decides in TypeScript;
// the save's guard raises an error when what the rule read has changed since, and this asks again on fresh facts.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

/** The save found the facts changed since the rule read them. Never shown to a person: the rule is asked again. */
export class ChangedSinceRead extends Data.TaggedError("ChangedSinceRead") {}

/**
 * Reads the facts, asks the rule and saves what it decides. When the save's guard raises (another writer changed the
 * facts between the read and the save), it reads and decides again, three times in all, so two taps at once both
 * count; it then gives up with the `gaveUp` error. Answers with the facts it decided on, what the rule decided (nothing,
 * when what was asked is already true), and what the save answered, which is there only when something was saved.
 */
export const decideAndSave = <F, W, E, S, E2, R1, R2>(steps: {
	facts: Effect.Effect<F, never, R1>;
	decide: (facts: F) => Effect.Effect<Option.Option<W>, E>;
	save: (write: W) => Effect.Effect<S, ChangedSinceRead | E2, R2>;
	gaveUp: string;
}) =>
	Effect.gen(function* () {
		const facts = yield* steps.facts;
		const decided = yield* steps.decide(facts);

		const saved = Option.isSome(decided)
			? yield* steps.save(decided.value)
			: undefined;

		return { facts, decided, saved };
	}).pipe(
		Effect.retry({ times: 2, while: Predicate.isTagged("ChangedSinceRead") }),
		Effect.catchTag("ChangedSinceRead", () =>
			Effect.die(new Error(steps.gaveUp)),
		),
	);
