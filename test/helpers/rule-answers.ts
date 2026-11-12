import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Refusal } from "../../src/rules/terms";

// A rule's answer in a story's words (decision 206): what to save, nothing to do, or a named refusal with its sentence.

export const write = <W>(save: W) => ({ kind: "write" as const, save });
export const nothingToDo = () => ({ kind: "nothingToDo" as const });

export const refuse = (type: string, say: string) => ({
	kind: "refuse" as const,
	type,
	say,
});

/** Runs what a rule's `decide` answered, which needs nothing handed in, and puts it in those words. */
export const answerOf = <W, E extends Refusal>(
	decided: Effect.Effect<Option.Option<W>, E>,
) =>
	Effect.runSync(
		Effect.match(decided, {
			onFailure: (refusal) => refuse(refusal._tag, refusal.say),
			onSuccess: (save) =>
				Option.isSome(save) ? write(save.value) : nothingToDo(),
		}),
	);
