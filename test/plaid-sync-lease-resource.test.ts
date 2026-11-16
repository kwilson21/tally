import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it, vi } from "vitest";
import { leaseScoped, withSyncLease } from "../src/plaid/sync-lease";
import { type LeaseCall, leaseSpy } from "./helpers/lease-spy";
import { present } from "./helpers/present";

// The bank sync lease as a scoped resource (#1164): withSyncLease takes the lease, runs the body and gives the lease back on
// every way the body ends, and a lease that is not taken is never released. The grid (plaid-sync-lease.test.ts) pins what a
// whole sync does; these tests pin the resource on its own.

const SUCCESS = { added: 0, modified: 0, removed: 0, changedIds: [] };

async function addItem(): Promise<number> {
	const row = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(new Uint8Array([1, 2, 3]), crypto.randomUUID())
		.first<{ id: number }>();

	return present(row).id;
}

async function reset() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
	]);
}

/** The one sentence a failed release logs: the item row id and nothing else (#1171). */
const releaseSentence = (id: number) =>
	`plaid sync could not release its lease for item ${id}`;

/** Runs `run` with console.error silenced, and returns the argument lists of the release's sentence logged for item `id`. */
async function withReleaseLog(
	id: number,
	run: () => Promise<unknown>,
): Promise<unknown[][]> {
	const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

	try {
		await run();

		return quiet.mock.calls
			.filter((call) => call[0] === releaseSentence(id))
			.map((call) => [...call]);
	} finally {
		quiet.mockRestore();
	}
}

const releases = (calls: LeaseCall[]) =>
	calls.filter((call) => call.kind === "release");

const takes = (calls: LeaseCall[]) =>
	calls.filter((call) => call.kind === "take");

describe("withSyncLease: the bank's lease around a run (#1164)", () => {
	it("gives the body's result back and releases the lease once, with the lock it took", async () => {
		await reset();
		const id = await addItem();
		const spy = leaseSpy(env.DB, {});

		const result = await withSyncLease(
			spy.db,
			id,
			"lock-1",
			async () => SUCCESS,
		);

		expect(result).toEqual(SUCCESS);
		expect(takes(spy.calls).map((call) => call.binds)).toEqual([
			["lock-1", id],
		]);
		expect(releases(spy.calls).map((call) => call.binds)).toEqual([
			[id, "lock-1"],
		]);
	});

	it("rethrows the body's own error object, after releasing once", async () => {
		await reset();
		const id = await addItem();
		const spy = leaseSpy(env.DB, {});
		const failure = new Error("the body failed");

		await expect(
			withSyncLease(spy.db, id, "lock-1", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(releases(spy.calls).map((call) => call.binds)).toEqual([
			[id, "lock-1"],
		]);
	});

	it("gives the body's result back when the body returns and the release fails, and logs the release once (#1171)", async () => {
		await reset();
		const id = await addItem();
		const spy = leaseSpy(env.DB, {
			failRelease: new Error("the release failed"),
		});
		const logged = await withReleaseLog(id, () =>
			expect(
				withSyncLease(spy.db, id, "lock-1", async () => SUCCESS),
			).resolves.toEqual(SUCCESS),
		);

		expect(logged).toEqual([[releaseSentence(id)]]);
	});

	it("rethrows the body's own error object, not the release's, when the body fails and the release fails too (#1171)", async () => {
		await reset();
		const id = await addItem();
		const spy = leaseSpy(env.DB, {
			failRelease: new Error("the release failed"),
		});
		const failure = new Error("the body failed");

		const logged = await withReleaseLog(id, () =>
			expect(
				withSyncLease(spy.db, id, "lock-1", async () => {
					throw failure;
				}),
			).rejects.toBe(failure),
		);

		expect(logged).toEqual([[releaseSentence(id)]]);
	});

	it("skips a held lease without running the body, and releases nothing", async () => {
		await reset();
		const id = await addItem();
		await env.DB.prepare(
			"UPDATE plaid_items SET sync_lock_id = 'held-run', sync_locked_until = datetime('now', '+1 hour') WHERE id = ?",
		)
			.bind(id)
			.run();
		const spy = leaseSpy(env.DB, {});
		const body = vi.fn(async () => SUCCESS);

		await expect(withSyncLease(spy.db, id, "lock-1", body)).resolves.toEqual({
			skipped: true,
		});
		expect(body).not.toHaveBeenCalled();
		expect(releases(spy.calls)).toEqual([]);
	});

	it("throws Plaid Item not found for a missing bank, without running the body or releasing", async () => {
		await reset();
		const spy = leaseSpy(env.DB, {});
		const body = vi.fn(async () => SUCCESS);

		await expect(
			withSyncLease(spy.db, 999_999, "lock-1", body),
		).rejects.toThrow("Plaid Item not found");
		expect(body).not.toHaveBeenCalled();
		expect(releases(spy.calls)).toEqual([]);
	});

	it("releases the lease once with the same lock when the run is interrupted mid-body", async () => {
		await reset();
		const id = await addItem();
		const spy = leaseSpy(env.DB, {});

		let started: () => void = () => {};

		const bodyStarted = new Promise<void>((resolve) => {
			started = resolve;
		});

		const body = async () => {
			started();

			await new Promise(() => {});

			return SUCCESS;
		};

		const fiber = Effect.runFork(leaseScoped(spy.db, id, "lock-1", body));

		await bodyStarted;
		await Effect.runPromise(Fiber.interrupt(fiber));

		expect(releases(spy.calls).map((call) => call.binds)).toEqual([
			[id, "lock-1"],
		]);
	});

	it("an interruption while the lease is being taken still releases it", async () => {
		await reset();
		const id = await addItem();

		let reached: () => void = () => {};

		const takeReached = new Promise<void>((resolve) => {
			reached = resolve;
		});

		let open: () => void = () => {};

		const takeGate = new Promise<void>((resolve) => {
			open = resolve;
		});

		const spy = leaseSpy(env.DB, { onTakeRun: reached, takeGate });
		const body = vi.fn(async () => SUCCESS);

		const fiber = Effect.runFork(leaseScoped(spy.db, id, "lock-1", body));

		// The take statement is running and has not landed: the fiber is interrupted in the middle of taking the lease.
		await takeReached;
		const interrupted = Effect.runPromise(Fiber.interrupt(fiber));

		// The take now lands, and takes the lease (its row is free).
		open();
		await interrupted;
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(takes(spy.calls).map((call) => call.binds)).toEqual([
			["lock-1", id],
		]);
		expect(body).not.toHaveBeenCalled();
		expect(releases(spy.calls).map((call) => call.binds)).toEqual([
			[id, "lock-1"],
		]);
	});
});
