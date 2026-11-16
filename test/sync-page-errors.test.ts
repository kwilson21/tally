import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { PlaidError } from "../src/plaid/client";
import { type SyncResult, syncItem } from "../src/plaid/sync";
import recorded from "./fixtures/sync-page-errors.json";
import {
	type Answer,
	failingSave,
	KEY,
	MUTATION,
	type PlaidScript,
	type PlaidTrace,
	page,
	resetBanks,
	response,
	scriptedPlaid,
	seedBank,
	type Thrown,
} from "./helpers/page-errors";
import { GOOD_PAGE } from "./sync-page-corpus";

// A page that cannot be asked for or saved carries its own error out of the page machine (#1164, step 2). Every cell runs the
// real syncItem against scripted Plaid and a D1 whose one save fails, and fixtures/sync-page-errors.json holds what each cell
// did on the code before the machine carried the error: the value it returned or the error it threw (with the same object,
// where the failing statement or Plaid client threw one), the bank's row, the stored charges and accounts, the Plaid asks
// and their cursors, and the console.error lines. A cell names what it does, and its letter is the case in the sync's notes.

const SAVE_ERROR = new Error("the page save failed");

const SAVE_PLAID_ERROR = new PlaidError({
	error_type: "ITEM_ERROR",
	error_code: "ITEM_LOGIN_REQUIRED",
	request_id: "request-save",
});

const pageOne = (): Answer => page("transaction-1", "c1", true);

const pageTwo = (): Answer => page("transaction-2", "c2", false);

const refused = (): Answer =>
	response(
		{
			error_type: "ITEM_ERROR",
			error_code: "ITEM_LOGIN_REQUIRED",
			request_id: "request-1",
		},
		400,
	);

const changed = (): Answer => response(MUTATION, 400);

/** Two pages, the second answered after the first saved, as a good update. */
const twoPages: PlaidScript["transactions"] = (call) =>
	call === 1 ? pageOne() : pageTwo();

type Save = { on: number; value: Thrown };

type Cell = {
	label: string;
	transactions: PlaidScript["transactions"];
	loginBroken?: boolean;
	/** The save that fails: the `on`th page's batch rejects with `value`. */
	save?: Save;
};

const cells: Cell[] = [
	{
		label: "(a) refused on the second page, after the first page saved",
		transactions: (call) => (call === 1 ? pageOne() : refused()),
	},
	{
		label:
			"(a2) refused on the second page, and Plaid says the login is broken",
		transactions: (call) => (call === 1 ? pageOne() : refused()),
		loginBroken: true,
	},
	{
		label: "(b) refused on the first page",
		transactions: () => refused(),
	},
	{
		label: "(c) changed, starts again, then refused",
		transactions: (call) =>
			call === 1 ? pageOne() : call === 2 ? changed() : refused(),
	},
	{
		label: "(d) changed, starts again, then succeeds",
		transactions: (call) =>
			call === 1
				? pageOne()
				: call === 2
					? changed()
					: call === 3
						? pageOne()
						: pageTwo(),
	},
	{
		label:
			"(e) changed on every ask: three restarts, then the fourth is refused",
		transactions: () => changed(),
	},
	{
		label: "(f) a save fails on the first page",
		transactions: twoPages,
		save: { on: 1, value: SAVE_ERROR },
	},
	{
		label: "(g) a save fails on the second page, after the first saved",
		transactions: twoPages,
		save: { on: 2, value: SAVE_ERROR },
	},
	{
		label: "(h) a save throws a string",
		transactions: twoPages,
		save: { on: 1, value: "the save broke" },
	},
	{
		label: "(h) a save throws 0",
		transactions: twoPages,
		save: { on: 1, value: 0 },
	},
	{
		label: "(h) a save throws an empty string",
		transactions: twoPages,
		save: { on: 1, value: "" },
	},
	{
		label: "(h) a save throws undefined",
		transactions: twoPages,
		save: { on: 1, value: undefined },
	},
	{
		label: "(h) a save throws null",
		transactions: twoPages,
		save: { on: 1, value: null },
	},
	{
		label:
			"(h2) a save throws a Plaid login error, and Plaid says the login is broken",
		transactions: twoPages,
		loginBroken: true,
		save: { on: 1, value: SAVE_PLAID_ERROR },
	},
	{
		label: "(i) the page cannot be read, so the ask fails with a plain Error",
		// The page's added is text, not a list, which the sync's page reader refuses before any statement is built.
		transactions: () => response({ ...GOOD_PAGE, added: "a page of text" }),
	},
	{
		label: "(j) the Plaid fetch throws, which is refused with no error code",
		transactions: () => "throws",
	},
];

type Settled =
	| { kind: "value"; value: SyncResult }
	| { kind: "threw"; thrown: Thrown }
	| { kind: "hangs" };

const SECONDS = 20_000;

/** The run's result, the value it threw as it was thrown, or "hangs" when it has not settled in SECONDS. */
async function settle(run: Promise<SyncResult>): Promise<Settled> {
	let timer: ReturnType<typeof setTimeout> | null = null;

	try {
		return await Promise.race([
			run.then((value): Settled => ({ kind: "value", value })),
			new Promise<Settled>((resolve) => {
				timer = setTimeout(() => resolve({ kind: "hangs" }), SECONDS);
			}),
		]);
	} catch (thrown) {
		// SAFETY: syncItem rejects with whatever it threw, which the cells' save values and the sync's own errors make a Thrown.
		return { kind: "threw", thrown: thrown as Thrown };
	} finally {
		clearTimeout(timer);
	}
}

/** A thrown value as the fixture names it: an Error by its name and message, a Plaid error with its fields, anything else by its JSON text. */
function describeThrown(thrown: Thrown, save: Save | undefined) {
	const identity =
		save === undefined
			? "no injected value"
			: Object.is(thrown, save.value)
				? "the injected value"
				: "another value";

	if (thrown instanceof PlaidError)
		return {
			kind: "PlaidError",
			error_type: thrown.error_type ?? null,
			error_code: thrown.error_code ?? null,
			request_id: thrown.request_id ?? null,
			identity,
		};

	if (thrown instanceof Error)
		return {
			kind: thrown.name,
			message: thrown.message,
			identity,
		};

	return {
		kind: "not an Error",
		text: JSON.stringify(thrown) ?? String(thrown),
		identity,
	};
}

const lockState = (value: string | null) => (value === null ? null : "<set>");

async function runCell(cell: Cell) {
	await resetBanks(env.DB);

	const id = await seedBank(env.DB);

	const plaid = scriptedPlaid({
		transactions: cell.transactions,
		loginBroken: cell.loginBroken ?? false,
	});

	const runEnv = {
		...env,
		DB: cell.save ? failingSave(env.DB, cell.save.on, cell.save.value) : env.DB,
		TOKEN_ENCRYPTION_KEY: KEY,
	};

	const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});

	let settled: Settled;
	let errorLines: string[] = [];

	try {
		settled = await settle(
			syncItem(runEnv, id, plaid.fetchImpl, { runAfterSync: false }),
		);
	} finally {
		errorLines = quiet.mock.calls.map((args) => args.map(String).join(" "));
		quiet.mockRestore();
		log.mockRestore();
	}

	const result =
		settled.kind === "hangs"
			? { hangs: true }
			: settled.kind === "threw"
				? { threw: describeThrown(settled.thrown, cell.save) }
				: {
						returned:
							"skipped" in settled.value
								? settled.value
								: {
										added: settled.value.added,
										modified: settled.value.modified,
										removed: settled.value.removed,
										changedIds: settled.value.changedIds.length,
									},
					};

	const bank = await env.DB.prepare(
		"SELECT sync_cursor, sync_update_cursor, status, sync_locked_until, sync_lock_id, disconnected_at FROM plaid_items WHERE id = ?",
	)
		.bind(id)
		.first<{
			sync_cursor: string | null;
			sync_update_cursor: string | null;
			status: string;
			sync_locked_until: string | null;
			sync_lock_id: string | null;
			disconnected_at: string | null;
		}>();

	const charges = await env.DB.prepare(
		"SELECT plaid_transaction_id, amount_cents FROM transactions ORDER BY plaid_transaction_id",
	).all();

	const accounts = await env.DB.prepare(
		"SELECT plaid_account_id FROM accounts ORDER BY plaid_account_id",
	).all();

	const trace: PlaidTrace = plaid.trace;

	return {
		...result,
		bank: bank
			? {
					sync_cursor: bank.sync_cursor,
					sync_update_cursor: bank.sync_update_cursor,
					status: bank.status,
					sync_locked_until: lockState(bank.sync_locked_until),
					sync_lock_id: lockState(bank.sync_lock_id),
					disconnected_at: lockState(bank.disconnected_at),
				}
			: null,
		charges: charges.results,
		accounts: accounts.results,
		asks: Object.fromEntries(trace.paths),
		cursors: trace.cursors,
		consoleErrors: errorLines,
	};
}

type Recorded = Awaited<ReturnType<typeof runCell>>;

describe("a page that cannot be asked for or saved (#1164, step 2)", () => {
	it("gives every cell the answer recorded for it before the page machine carried the error", async () => {
		const answers: Record<string, Recorded> = {};

		for (const cell of cells) answers[cell.label] = await runCell(cell);

		expect(Object.keys(answers).sort()).toEqual(Object.keys(recorded).sort());
		expect(answers).toEqual(recorded);
	}, 900_000);
});
