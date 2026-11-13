import { createEffectLogic, setupEffect } from "@xstate/effect";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// The moves of one bank's sync through the pages of a Plaid update (decision 206, style 2: the XState and Effect
// bridge; decision 210, the sync engine's third step). Each move waits on outside work whose answer decides the next:
//
//   asking_plaid      Tally asks Plaid for the page at its position. A page goes on to be saved. If Plaid says the
//                     update changed while it was being paged, the run starts again from the update's first cursor
//                     (Plaid's rule, decision 221), up to three times. Anything else Plaid refuses ends the run.
//   saving_the_page   The page's rows and its position are saved together. Then the next page is asked for, or, after
//                     the last page, the run is done. A save that fails ends the run.
//
// The machine holds only where the run is: the cursor, how many times it started again, and whether the next page is
// the first of a pass. The pages themselves, and what a save writes, stay in src/plaid/sync.ts, which provides the two
// pieces of outside work below.

/** How many times one run starts an update again after Plaid says it changed. */
export const RESTARTS = 3;

/** Plaid's answer to a request for a page, as far as the next move needs it. */
const Asked = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("page"),
		next: Schema.String,
		more: Schema.Boolean,
	}),
	Schema.Struct({ kind: Schema.Literal("changed") }),
	Schema.Struct({ kind: Schema.Literal("refused") }),
	// Plaid was never reached or its answer could not be used: not Plaid refusing, so the bank's state is left alone.
	Schema.Struct({ kind: Schema.Literal("failed") }),
]);

export type Asked = typeof Asked.Type;

/** Whether the page and its position were saved. */
const Saved = Schema.Literals(["saved", "failed"]);

export type Saved = typeof Saved.Type;

const Cursor = Schema.NullOr(Schema.String);
const AskAt = Schema.Struct({ cursor: Cursor, restarts: Schema.Number });
const SaveAt = Schema.Struct({ cursor: Cursor, fresh: Schema.Boolean });

/** The outside work of a sync: asking Plaid for the page at a cursor, and saving the page that came back. */
export class SyncPages extends Context.Service<
	SyncPages,
	{
		/** Asks Plaid for the page at `cursor`. `restarts` is how many times this run has started again. Never fails. */
		readonly ask: (at: typeof AskAt.Type) => Effect.Effect<Asked>;
		/**
		 * Saves the page just asked for, which was asked for at `cursor`. `fresh` is true for the first page of a pass,
		 * the run's first or one after starting again. Never fails: a save that could not be made is "failed".
		 */
		readonly save: (at: typeof SaveAt.Type) => Effect.Effect<Saved>;
	}
>()("tally/plaid/SyncPages") {}

/** How a run ended: every page saved, Plaid refused, or a save failed. */
export type SyncOutcome = "running" | "done" | "refused" | "failed";

const RUNNING: SyncOutcome = "running";

export const syncPagesMachine = setupEffect({
	schemas: {
		// `first` is the cursor of the update's first page; `cursor` is where this run goes on from.
		input: Schema.Struct({ first: Cursor, cursor: Cursor }),
	},
	actors: {
		ask: createEffectLogic({
			schemas: { input: AskAt },
			effect: ({ input }) => SyncPages.use((sync) => sync.ask(input)),
		}),
		save: createEffectLogic({
			schemas: { input: SaveAt },
			effect: ({ input }) => SyncPages.use((sync) => sync.save(input)),
		}),
	},
}).createMachine({
	id: "syncPages",
	context: ({ input }) => ({
		first: input.first,
		cursor: input.cursor,
		restarts: 0,
		/** The next page saved is the first of a pass. */
		fresh: true,
		/** The cursor after the page being saved, and whether more pages follow it. */
		next: "",
		more: false,
		outcome: RUNNING,
	}),
	initial: "asking_plaid",
	states: {
		asking_plaid: {
			invoke: {
				src: "ask",
				input: ({ context }) => ({
					cursor: context.cursor,
					restarts: context.restarts,
				}),
				onDone: ({ context, event }) => {
					const asked = event.output;

					if (asked.kind === "page")
						return {
							target: "saving_the_page",
							context: { ...context, next: asked.next, more: asked.more },
						};

					if (asked.kind === "changed" && context.restarts < RESTARTS)
						return {
							target: "starting_again",
							context: {
								...context,
								cursor: context.first,
								restarts: context.restarts + 1,
								fresh: true,
							},
						};

					if (asked.kind === "failed")
						return {
							target: "failed",
							context: { ...context, outcome: "failed" },
						};

					return {
						target: "refused",
						context: { ...context, outcome: "refused" },
					};
				},
				onError: ({ context }) => ({
					target: "failed",
					context: { ...context, outcome: "failed" },
				}),
			},
		},
		// Leaving and coming back is what asks Plaid again.
		starting_again: { always: { target: "asking_plaid" } },
		saving_the_page: {
			invoke: {
				src: "save",
				input: ({ context }) => ({
					cursor: context.cursor,
					fresh: context.fresh,
				}),
				onDone: ({ context, event }) => {
					if (event.output === "failed")
						return {
							target: "failed",
							context: { ...context, outcome: "failed" },
						};

					return context.more
						? {
								target: "asking_plaid",
								context: { ...context, cursor: context.next, fresh: false },
							}
						: { target: "done", context: { ...context, outcome: "done" } };
				},
				onError: ({ context }) => ({
					target: "failed",
					context: { ...context, outcome: "failed" },
				}),
			},
		},
		done: { type: "final" },
		refused: { type: "final" },
		failed: { type: "final" },
	},
});
