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

/** Runs a sync from `cursor` against scripted answers, and says what was asked and saved. */
async function run(
	at: { first: string | null; cursor: string | null },
	plaid: (cursor: string | null, asks: number) => Asked,
	save: (cursor: string | null) => Saved = () => "saved",
) {
	const asked: (string | null)[] = [];
	const saved: { cursor: string | null; fresh: boolean }[] = [];

	const landed = await Effect.runPromise(
		Effect.gen(function* () {
			const actor = yield* createEffectActor(syncPagesMachine, { input: at });

			return yield* waitFor(
				actor,
				(snapshot) => snapshot.context.outcome !== "running",
				{ timeout: "5 seconds" },
			);
		}).pipe(
			Effect.scoped,
			Effect.provideService(SyncPages, {
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
			}),
		),
	);

	return { outcome: landed.context.outcome, asked, saved };
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
				cursor === "m" ? { kind: "changed" } : page("z", false),
			),
		).toEqual({
			outcome: "done",
			asked: ["m", "a"],
			saved: [{ cursor: "a", fresh: true }],
		});
	});

	it("gives up after starting again three times", async () => {
		expect(
			await run({ first: "a", cursor: "a" }, () => ({ kind: "changed" })),
		).toEqual({ outcome: "refused", asked: ["a", "a", "a", "a"], saved: [] });
	});

	it("ends refused when Plaid refuses for any other reason, and saves nothing more", async () => {
		expect(
			await run({ first: null, cursor: null }, (_cursor, asks) =>
				asks === 1 ? page("b", true) : { kind: "refused" },
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
				() => "failed",
			),
		).toEqual({
			outcome: "failed",
			asked: ["a"],
			saved: [{ cursor: "a", fresh: true }],
		});
	});
});
