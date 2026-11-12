import { env } from "cloudflare:workers";
import {
	createEffectActor,
	createEffectLogic,
	send,
	setupEffect,
	waitFor,
} from "@xstate/effect";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";

// The proof decision 206 asks for before any handler uses the XState and Effect bridge: inside the Workers runtime,
// against a real D1, a machine is restored from what Tally's tables hold (a status column, not the bridge's own
// snapshot), takes one event, waits on outside work, and the state it lands on is saved. The machine here is a small
// stand-in written for this test; no handler uses the bridge yet.

class BankRefused extends Data.TaggedError("BankRefused") {}

/** The outside work: asking the bank's service to remove a connection. */
class Bank extends Context.Service<
	Bank,
	{ readonly remove: (id: number) => Effect.Effect<void, BankRefused> }
>()("test/Bank") {}

const removeAtBank = createEffectLogic({
	schemas: { input: Schema.Struct({ id: Schema.Number }) },
	effect: ({ input }) => Bank.use((bank) => bank.remove(input.id)),
});

const connection = setupEffect({
	schemas: { input: Schema.Struct({ id: Schema.Number }) },
	actors: { removeAtBank },
}).createMachine({
	id: "connectionProof",
	context: ({ input }) => ({ id: input.id, refused: false }),
	initial: "ok",
	states: {
		ok: { on: { DISCONNECT: { target: "removing" } } },
		login_broken: { on: { DISCONNECT: { target: "removing" } } },
		removing: {
			invoke: {
				src: "removeAtBank",
				input: ({ context }) => ({ id: context.id }),
				onDone: { target: "disconnected" },
				onError: ({ context }) => ({
					target: "login_broken",
					context: { ...context, refused: true },
				}),
			},
		},
		disconnected: { type: "final" },
	},
});

const db = env.DB;

const stored = async () =>
	(
		await db
			.prepare("SELECT value FROM household_settings WHERE key = 'proof'")
			.first<{ value: string }>()
	)?.value;

/** One request: read the stored state, restore the machine at it, send the event, wait, and save where it landed. */
const disconnect = (id: number) =>
	Effect.gen(function* () {
		const database = yield* Database;

		const row = yield* Effect.promise(() =>
			database
				.prepare("SELECT value FROM household_settings WHERE key = 'proof'")
				.first<{ value: string }>(),
		);

		const actor = yield* createEffectActor(connection, {
			input: { id },
			snapshot: connection.getPersistedSnapshot(
				connection.resolveState({
					value: row?.value ?? "ok",
					context: { id, refused: false },
				}),
			),
		});

		yield* send(actor, { type: "DISCONNECT" });

		const landed = yield* waitFor(
			actor,
			(s) => s.matches("disconnected") || s.context.refused,
			{ timeout: "5 seconds" },
		);

		yield* Effect.promise(() =>
			database
				.prepare("UPDATE household_settings SET value = ? WHERE key = 'proof'")
				.bind(String(landed.value))
				.run(),
		);

		return String(landed.value);
	}).pipe(Effect.scoped, Effect.provideService(Database, db));

beforeEach(async () => {
	await db.batch([
		db.prepare("DELETE FROM household_settings WHERE key = 'proof'"),
		db.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('proof', 'login_broken')",
		),
	]);
});

describe("the XState and Effect bridge in the Workers runtime", () => {
	it("restores a machine from a stored state, waits on outside work, and saves where it landed", async () => {
		const removed: number[] = [];

		const landed = await Effect.runPromise(
			disconnect(7).pipe(
				Effect.provideService(Bank, {
					remove: (id) => Effect.sync(() => void removed.push(id)),
				}),
			),
		);

		expect(landed).toBe("disconnected");
		expect(removed).toEqual([7]);
		expect(await stored()).toBe("disconnected");
	});

	it("lands on the state the machine names when the outside work is refused", async () => {
		const landed = await Effect.runPromise(
			disconnect(7).pipe(
				Effect.provideService(Bank, {
					remove: () => Effect.fail(new BankRefused()),
				}),
			),
		);

		expect(landed).toBe("login_broken");
		expect(await stored()).toBe("login_broken");
	});

	it("takes no event from a final state", async () => {
		await db
			.prepare(
				"UPDATE household_settings SET value = 'disconnected' WHERE key = 'proof'",
			)
			.run();

		await expect(
			Effect.runPromise(
				disconnect(7).pipe(
					Effect.provideService(Bank, { remove: () => Effect.void }),
				),
			),
		).resolves.toBe("disconnected");
	});
});
