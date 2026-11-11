// The one shape every back-end rule is written in (decision 192). A rule takes a typed request and the stored facts,
// and answers with one of three outcomes: what to save, nothing to do, or a named refusal. It reads no clock and no
// database (decision 195). This file may not grow past about 80 lines without a decision entry.

declare const made: unique symbol;
/** Only write(), nothingToDo() and refuse() can make one: a hand-written literal has no brand and fails the typecheck. */
type Made = { readonly [made]: true };

/** What a rule answers: what to save, nothing to do (what was asked is already true), or a named refusal in words. */
export type Outcome<W> = Made &
	(
		| { readonly kind: "write"; readonly write: W }
		| { readonly kind: "nothingToDo" }
		| { readonly kind: "refuse"; readonly type: string; readonly say: string }
	);

export const write = <W>(what: W) =>
	({ kind: "write", write: what }) as Outcome<W>;
export const nothingToDo = () => ({ kind: "nothingToDo" }) as Outcome<never>;
export const refuse = (type: string, say: string) =>
	({ kind: "refuse", type, say }) as Outcome<never>;

/** Runs the one branch for this outcome's kind. Leaving a kind out fails the typecheck. */
export function handle<W, R>(
	outcome: Outcome<W>,
	on: {
		write: (what: W) => R;
		nothingToDo: () => R;
		refuse: (type: string, say: string) => R;
	},
): R {
	if (outcome.kind === "write") return on.write(outcome.write);
	if (outcome.kind === "nothingToDo") return on.nothingToDo();
	return on.refuse(outcome.type, outcome.say);
}

/** A named condition: its English text is its name, and rules share the same term. */
export type Term<G> = {
	readonly text: string;
	readonly holds: (given: G) => boolean;
};
export const term = <G>(
	text: string,
	holds: (given: G) => boolean,
): Term<G> => ({
	text,
	holds,
});

/** A refusal: unless the term holds, the rule answers with this name and this sentence. */
export type Refusal<G> = {
	readonly unless: Term<G>;
	readonly type: string;
	readonly say: string;
};
export const unless = <G>(
	condition: Term<G>,
	type: string,
	say: string,
): Refusal<G> => ({ unless: condition, type, say });

/**
 * Defines a rule. `given` works out, once, the values the checks use. `nothingToDoIf` is checked first, so a repeat is
 * never refused by its own effect. The refusals are then checked in order, and the first whose term does not hold is the
 * answer. Otherwise `writes` says what to save, and `writesText` says it in words.
 */
export function defineRule2<Request, Facts, G, W>(rule: {
	name: string;
	given: (request: Request, facts: Facts) => G;
	nothingToDoIf: Term<G>;
	refusals: Refusal<G>[];
	writes: (given: G) => W;
	writesText: string;
}) {
	return {
		...rule,
		decide(request: Request, facts: Facts): Outcome<W> {
			const given = rule.given(request, facts);
			if (rule.nothingToDoIf.holds(given)) return nothingToDo();
			const refused = rule.refusals.find((r) => !r.unless.holds(given));
			return refused
				? refuse(refused.type, refused.say)
				: write(rule.writes(given));
		},
	};
}
