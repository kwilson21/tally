import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { type SyncResult, syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import grid from "./fixtures/sync-lease-grid.json";
import { type LeaseCall, leaseSpy } from "./helpers/lease-spy";
import { present } from "./helpers/present";
import { GOOD_ACCOUNT, GOOD_PAGE } from "./sync-page-corpus";

// The bank sync lease, cell by cell (#1164): every bank state against every way a run can end, recorded on the sync as it
// was before the lease became an Effect resource, and fixtures/sync-lease-grid.json holds what it did. A conversion must
// leave every cell's answer where it is: the same returned value or thrown error (and the same error object where the grid
// compares it), the same bank row, the same Plaid asks, the same lease statements with the same values, and the same stored
// charges. A release that fails is logged once, by a fixed sentence that names the item and nothing else, and leaves the
// run's own result or error as it is (#1171).

const KEY = btoa("01234567890123456789012345678901");

/** An item row id no row has, for the bank that is missing. */
const MISSING_ITEM = 999_999;

const SECONDS = 20_000;

const BANKS = ["free", "expired", "held", "disconnected", "missing"] as const;

const ENDINGS = [
	"done",
	"refused at accounts",
	"refused at transactions",
	"fetch throws",
	"ask fails",
	"save fails",
	"no key",
] as const;

type Bank = (typeof BANKS)[number];

type Ending = (typeof ENDINGS)[number];

type Json =
	| string
	| number
	| boolean
	| null
	| undefined
	| Json[]
	| { [key: string]: Json };

const ITEM_ERROR = {
	error_type: "ITEM_ERROR",
	error_code: "ITEM_LOGIN_REQUIRED",
	error_message: "the login needs attention",
	request_id: "request-1",
};

const response = (body: Json, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

async function reset() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchant_suggested_names"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
	await saveAiSwitches(env.DB, { details: false });
}

/** A bank in the state the cell names: its row with its lease or disconnection set, or no row at all. */
async function seedBank(bank: Bank): Promise<number> {
	if (bank === "missing") return MISSING_ITEM;

	const row = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(await encryptToken("secret-access-token", KEY), crypto.randomUUID())
		.first<{ id: number }>();

	const id = present(row).id;

	const state: string | null = {
		free: null,
		expired:
			"UPDATE plaid_items SET sync_lock_id = 'expired-run', sync_locked_until = datetime('now', '-1 hour') WHERE id = ?",
		held: "UPDATE plaid_items SET sync_lock_id = 'held-run', sync_locked_until = datetime('now', '+1 hour') WHERE id = ?",
		disconnected:
			"UPDATE plaid_items SET disconnected_at = datetime('now') WHERE id = ?",
	}[bank];

	if (state) await env.DB.prepare(state).bind(id).run();

	return id;
}

/** Plaid as the run meets it: the cell's ending decides what /transactions/sync answers, and /item/get answers as a login that works. */
function plaidFor(ending: Ending, paths: Map<string, number>) {
	return vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
		const path = new URL(String(url)).pathname;

		paths.set(path, (paths.get(path) ?? 0) + 1);

		if (path === "/accounts/get") {
			if (ending === "refused at accounts") return response(ITEM_ERROR, 400);

			return response({ accounts: [GOOD_ACCOUNT] });
		}

		if (path === "/transactions/sync") {
			if (ending === "refused at transactions")
				return response(ITEM_ERROR, 400);

			if (ending === "fetch throws")
				throw new TypeError("fetch failed: the network is down");

			if (ending === "ask fails") return response({});

			return response(GOOD_PAGE);
		}

		return response({ item: { error: null } });
	});
}

/** A lock id as the grid names it: the run's own, the two the bank rows were seeded with, or any other. */
function lockName(
	value: string | number | null | undefined,
	runLock: string | number | null,
): string | null {
	if (value === null || value === undefined) return null;

	if (value === runLock) return "<run lock>";

	if (value === "expired-run" || value === "held-run") return String(value);

	return "<other lock>";
}

/** A thrown value as the grid names it: its name and message for an Error, and whether it is the injected save error. */
function describeThrown(thrown: Error, injected: { save: Error }) {
	return {
		thrown: `${thrown.name}: ${thrown.message}`,
		identity:
			thrown === injected.save ? "the save's error object" : "another object",
	};
}

type Outcome = { value: SyncResult } | { thrown: Error } | "hangs";

/** The run's result, its thrown error, or "hangs" when it has not settled in SECONDS. */
async function settle(run: Promise<SyncResult>): Promise<Outcome> {
	let timer: ReturnType<typeof setTimeout> | null = null;

	try {
		return await Promise.race([
			run.then((value) => ({ value })),
			new Promise<"hangs">((resolve) => {
				timer = setTimeout(() => resolve("hangs"), SECONDS);
			}),
		]);
	} catch (thrown) {
		return {
			thrown: thrown instanceof Error ? thrown : new Error(String(thrown)),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function runCell(bank: Bank, ending: Ending, releaseFails: boolean) {
	await reset();
	const id = await seedBank(bank);
	const paths = new Map<string, number>();

	const injected = {
		save: new Error("the page save failed"),
	};

	const spy = leaseSpy(env.DB, {
		failRelease: releaseFails
			? new Error("the release statement failed")
			: undefined,
		failBatch: ending === "save fails" ? injected.save : undefined,
	});

	const runEnv = {
		...env,
		DB: spy.db,
		TOKEN_ENCRYPTION_KEY: ending === "no key" ? undefined : KEY,
	};

	const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const releaseSentence = `plaid sync could not release its lease for item ${id}`;
	let releaseLog: number[] = [];
	let outcome: Outcome;

	try {
		outcome = await settle(
			syncItem(runEnv, id, plaidFor(ending, paths), {
				runAfterSync: false,
			}),
		);
	} finally {
		releaseLog = quiet.mock.calls
			.filter((call) => call[0] === releaseSentence)
			.map((call) => call.length);
		quiet.mockRestore();
		log.mockRestore();
	}

	const takes = spy.calls.filter((call) => call.kind === "take");
	const runLock = takes[0]?.binds[0] ?? null;

	const bankRow = await env.DB.prepare(
		"SELECT sync_cursor, sync_locked_until, sync_lock_id, disconnected_at, status FROM plaid_items WHERE id = ?",
	)
		.bind(id)
		.first<{
			sync_cursor: string | null;
			sync_locked_until: string | null;
			sync_lock_id: string | null;
			disconnected_at: string | null;
			status: string;
		}>();

	const transactions = await env.DB.prepare(
		"SELECT plaid_transaction_id, amount_cents FROM transactions ORDER BY plaid_transaction_id",
	).all();

	const accounts = await env.DB.prepare(
		"SELECT plaid_account_id FROM accounts ORDER BY plaid_account_id",
	).all();

	// The take binds (lock, item); the release binds (item, lock). Both are named by the same rule.
	const leaseStatements = (kind: LeaseCall["kind"]) =>
		spy.calls
			.filter((call) => call.kind === kind)
			.map((call) => {
				const lock = kind === "take" ? call.binds[0] : call.binds[1];
				const item = kind === "take" ? call.binds[1] : call.binds[0];

				return {
					item: item === id ? "<item>" : String(item),
					lock: lockName(lock, runLock),
				};
			});

	const result =
		outcome === "hangs"
			? { hangs: true }
			: "value" in outcome
				? "skipped" in outcome.value
					? { returned: outcome.value }
					: {
							returned: {
								added: outcome.value.added,
								modified: outcome.value.modified,
								removed: outcome.value.removed,
								changedIds: outcome.value.changedIds.length,
							},
						}
				: describeThrown(outcome.thrown, injected);

	const answer = {
		...result,
		bank: bankRow
			? {
					sync_cursor: bankRow.sync_cursor,
					sync_locked_until:
						bankRow.sync_locked_until === null ? null : "<time>",
					sync_lock_id: lockName(bankRow.sync_lock_id, runLock),
					disconnected_at: bankRow.disconnected_at === null ? null : "<time>",
					status: bankRow.status,
				}
			: null,
		takes: leaseStatements("take"),
		releases: leaseStatements("release"),
		plaidPaths: Object.fromEntries(paths),
		charges: transactions.results,
		accounts: accounts.results,
	};

	return { answer, releaseLog };
}

const cells = [
	...(["free", "expired"] as const).flatMap((bank) =>
		ENDINGS.flatMap((ending) =>
			[false, true].map((releaseFails) => ({
				label: `${bank} | ${ending} | release ${releaseFails ? "fails" : "ok"}`,
				bank,
				ending,
				releaseFails,
			})),
		),
	),
	// A lease that is not taken: the run ends before its body, so the ending is not observable. The release fails here
	// too, so a release that ran would show.
	...(["held", "disconnected", "missing"] as const).map((bank) => ({
		label: `${bank} | not taken`,
		bank,
		ending: ENDINGS[0],
		releaseFails: true,
	})),
];

describe("the sync's bank lease, cell by cell (#1164)", () => {
	it("gives every cell the answer recorded for it before the lease became a resource", async () => {
		const got = new Map<string, Awaited<ReturnType<typeof runCell>>>();

		for (const cell of cells) {
			got.set(
				cell.label,
				await runCell(cell.bank, cell.ending, cell.releaseFails),
			);
		}

		const answers = Object.fromEntries(
			[...got].map(([label, run]) => [label, run.answer]),
		);

		expect(Object.keys(answers).sort()).toEqual(Object.keys(grid).sort());
		expect(answers).toEqual(grid);

		// A failing release is logged once, with the fixed sentence; a cell whose lease is not taken runs no release, so logs nothing.
		const releaseLogs = Object.fromEntries(
			[...got].map(([label, run]) => [label, run.releaseLog]),
		);
		const expectedLogs = Object.fromEntries(
			cells.map((cell) => [
				cell.label,
				cell.releaseFails && (cell.bank === "free" || cell.bank === "expired")
					? [1]
					: [],
			]),
		);

		expect(releaseLogs).toEqual(expectedLogs);
	}, 900_000);
});
