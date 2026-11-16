import { createEffectActor, waitFor } from "@xstate/effect";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	type Asked,
	type Saved,
	SyncPages,
	syncPagesMachine,
} from "../src/machines/sync-pages";

// A bank's sync as stories (decisions 206 style 2, 210): what Plaid answers at each cursor, and where the run ends.
// Plaid and the save are stand-ins; nothing touches a database.

const page = (next: string, more: boolean): Asked => ({
	kind: "page",
	next,
	more,
});

// The errors the stand-ins answer with. Each is one object, so a test can check the run ends with that same object.
const RESTART = new Error("the update changed");
const REFUSAL = new Error("Plaid refused");
const FAILURE = new Error("the ask failed");
const SAVE_FAILURE = new Error("the save failed");

type At = { cursor: string | null; restarts: number };

/** Ends a run from `at` with the given stand-ins, and says where it ended: the machine's context at the end. */
async function land(
	at: { first: string | null; cursor: string | null },
	stand: {
		ask: (at: At) => Effect.Effect<Asked>;
		save: (at: {
			cursor: string | null;
			fresh: boolean;
		}) => Effect.Effect<Saved>;
	},
) {
	const landed = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(syncPagesMachine, { input: at });

			return yield* waitFor(
				actor,
				(snapshot) => snapshot.context.outcome !== "running",
				{ timeout: "5 seconds" },
			);
		}).pipe(Effect.scoped, Effect.provideService(SyncPages, stand)),
	);

	return landed.context;
}

/** Runs a sync from `cursor` against scripted answers, and says what was asked and saved. */
async function run(
	at: { first: string | null; cursor: string | null },
	plaid: (cursor: string | null, asks: number) => Asked,
	save: (cursor: string | null) => Saved = () => "saved",
) {
	const asked: (string | null)[] = [];
	const saved: { cursor: string | null; fresh: boolean }[] = [];

	const context = await land(at, {
		ask: ({ cursor }) =>
			Effect.sync(() => {
				asked.push(cursor);

				return plaid(cursor, asked.length);
			}),
		save: (at) =>
			Effect.sync(() => {
				saved.push(at);

				return save(at.cursor);
			}),
	});

	return { outcome: context.outcome, asked, saved };
}

describe("a bank's sync, page by page", () => {
	it("saves each page and asks for the next from its cursor, until the last", async () => {
		expect(
			await run({ first: "a", cursor: "a" }, (cursor) =>
				cursor === "a" ? page("b", true) : page("c", false),
			),
		).toEqual({
			outcome: "done",
			asked: ["a", "b"],
			saved: [
				{ cursor: "a", fresh: true },
				{ cursor: "b", fresh: false },
			],
		});
	});

	it("starts again from the update's first cursor when Plaid says the update changed", async () => {
		expect(
			await run({ first: "a", cursor: "m" }, (cursor) =>
				cursor === "m" ? { kind: "changed", error: RESTART } : page("z", false),
			),
		).toEqual({
			outcome: "done",
			asked: ["m", "a"],
			saved: [{ cursor: "a", fresh: true }],
		});
	});

	it("gives up after starting again three times", async () => {
		expect(
			await run({ first: "a", cursor: "a" }, () => ({
				kind: "changed",
				error: RESTART,
			})),
		).toEqual({ outcome: "refused", asked: ["a", "a", "a", "a"], saved: [] });
	});

	it("ends refused when Plaid refuses for any other reason, and saves nothing more", async () => {
		expect(
			await run({ first: null, cursor: null }, (_cursor, asks) =>
				asks === 1 ? page("b", true) : { kind: "refused", error: REFUSAL },
			),
		).toEqual({
			outcome: "refused",
			asked: [null, "b"],
			saved: [{ cursor: null, fresh: true }],
		});
	});

	it("ends failed when a save fails, and asks for nothing more", async () => {
		expect(
			await run(
				{ first: "a", cursor: "a" },
				() => page("b", true),
				() => ({ kind: "failed", error: SAVE_FAILURE }),
			),
		).toEqual({
			outcome: "failed",
			asked: ["a"],
			saved: [{ cursor: "a", fresh: true }],
		});
	});
});

describe("the error a run ends with (#1164, step 2)", () => {
	it("is the refusal's own object, as Plaid's client threw it", async () => {
		const context = await land(
			{ first: null, cursor: null },
			{
				ask: () => Effect.succeed<Asked>({ kind: "refused", error: REFUSAL }),
				save: () => Effect.succeed<Saved>("saved"),
			},
		);

		expect(context.outcome).toBe("refused");
		expect(context.error).toBe(REFUSAL);
	});

	it("is the failed ask's own object", async () => {
		const context = await land(
			{ first: null, cursor: null },
			{
				ask: () => Effect.succeed<Asked>({ kind: "failed", error: FAILURE }),
				save: () => Effect.succeed<Saved>("saved"),
			},
		);

		expect(context.outcome).toBe("failed");
		expect(context.error).toBe(FAILURE);
	});

	it("is the failed save's own object, and the run asks for nothing more", async () => {
		const context = await land(
			{ first: "a", cursor: "a" },
			{
				ask: () => Effect.succeed(page("b", true)),
				save: () =>
					Effect.succeed<Saved>({ kind: "failed", error: SAVE_FAILURE }),
			},
		);

		expect(context.outcome).toBe("failed");
		expect(context.error).toBe(SAVE_FAILURE);
	});

	it("is a save's value that is not an Error, as the save gave it", async () => {
		const context = await land(
			{ first: "a", cursor: "a" },
			{
				ask: () => Effect.succeed(page("b", true)),
				save: () => Effect.succeed<Saved>({ kind: "failed", error: 0 }),
			},
		);

		expect(context.outcome).toBe("failed");
		expect(context.error).toBe(0);
	});

	it("is the last error the run met: a refusal after a restart replaces the restart's", async () => {
		const context = await land(
			{ first: "a", cursor: "a" },
			{
				ask: ({ restarts }) =>
					Effect.succeed<Asked>(
						restarts === 0
							? { kind: "changed", error: RESTART }
							: { kind: "refused", error: REFUSAL },
					),
				save: () => Effect.succeed<Saved>("saved"),
			},
		);

		expect(context.outcome).toBe("refused");
		expect(context.error).toBe(REFUSAL);
	});

	it("is null while the run is still going, and when a run is done", async () => {
		const context = await land(
			{ first: "a", cursor: "a" },
			{
				ask: () => Effect.succeed(page("b", false)),
				save: () => Effect.succeed<Saved>("saved"),
			},
		);

		expect(context.outcome).toBe("done");
		expect(context.error).toBeNull();
	});

	// The one named difference of this step: an error thrown inside an invoke itself is not the answer's error, so the
	// run ends failed with no error and the sync throws its fallback. It is reached only if an ask or save dies, which the
	// sync's own closures never do, since each catches what it throws.
	it("ends failed with no error when an ask dies inside its invoke", async () => {
		const context = await land(
			{ first: "a", cursor: "a" },
			{
				ask: () => Effect.die(FAILURE),
				save: () => Effect.succeed<Saved>("saved"),
			},
		);

		expect(context.outcome).toBe("failed");
		expect(context.error).toBeNull();
	});
});
