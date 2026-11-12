// Named terms and the one form every Effect rule is written in (decision 205). A condition's English text is its name,
// and rules share the same term (decision 198's one vocabulary). A rule states each of its parts once, as a list, and
// `rule` builds its `decide` from them, so the rule sheet and the code cannot disagree.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

/**
 * Defines a rule from its parts. `given` works out, once, the values the checks use from the request and the stored
 * facts. `nothingToDoIf` is checked first, so a second press is never refused by its own effect (decision 194); a rule
 * that always has something to do leaves it out. The refusals are then checked in order, and the first whose term does
 * not hold is what `decide` fails with. Otherwise `writes` says what to save, and `writesText` says it in words.
 * `decide` answers with what to save, or with nothing when what was asked is already true.
 */
export const rule = <
	Request,
	Facts,
	G,
	const R extends readonly Unless<G, Refusal>[],
	W,
>(parts: {
	name: string;
	given: (request: Request, facts: Facts) => G;
	nothingToDoIf?: Term<G>;
	refusals: R;
	writes: (given: G) => W;
	writesText: string;
}) => ({
	...parts,
	decide: (request: Request, facts: Facts) => {
		const given = parts.given(request, facts);

		return parts.nothingToDoIf?.holds(given)
			? Effect.succeed(Option.none<W>())
			: check(given, parts.refusals).pipe(
					Effect.as(Option.some(parts.writes(given))),
				);
	},
});
