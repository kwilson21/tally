// Named terms for the Effect rules (decision 205): a condition's English text is its name, and rules share the same
// term (decision 198's one vocabulary). A rule lists its refusals as terms, so its rule sheet can be generated from the
// list, and checks them in order with `check`.
import * as Effect from "effect/Effect";

/** A named condition: its English text is its name. */
export type Term<G> = {
	readonly text: string;
	readonly holds: (given: G) => boolean;
};

export const term = <G>(
	text: string,
	holds: (given: G) => boolean,
): Term<G> => ({ text, holds });

/** What a refusal carries: its name (`_tag`) and the sentence a person reads. */
export type Refusal = { readonly _tag: string; readonly say: string };

/** A refusal: unless the term holds, the rule fails with what `refuse` makes. */
export type Unless<G, E extends Refusal> = {
	readonly unless: Term<G>;
	readonly refuse: () => E;
};

export const unless = <G, E extends Refusal>(
	condition: Term<G>,
	refuse: () => E,
): Unless<G, E> => ({ unless: condition, refuse });

/** Checks the refusals in order, and fails with the first whose term does not hold. */
export const check = <G, R extends readonly Unless<G, Refusal>[]>(
	given: G,
	refusals: R,
): Effect.Effect<void, ReturnType<R[number]["refuse"]>> => {
	const refused = refusals.find((r) => !r.unless.holds(given));

	// SAFETY: `refuse` of an entry of R makes one of the refusals R's entries make, which is the type named above.
	return refused
		? Effect.fail(refused.refuse() as ReturnType<R[number]["refuse"]>)
		: Effect.void;
};
