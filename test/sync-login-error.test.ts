import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { PlaidError } from "../src/plaid/client";
import { loginStillBroken } from "../src/plaid/login-broken";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import recorded from "./fixtures/sync-login-error.json";
import {
	type Answer,
	failingStatements,
	KEY,
	type PlaidScript,
	resetBanks,
	response,
	scriptedPlaid,
	seedBank,
	type Thrown,
} from "./helpers/page-errors";

// The login check the sync and the Plaid webhook ask after a login error (#1192, step 1). Every cell runs the real code
// (syncItem, loginStillBroken or the webhook route) against scripted Plaid and a D1 that can fail one state read or one
// flag write. fixtures/sync-login-error.json holds what each cell did before the check moved onto the bank-request
// machine: the value it returned or the error it threw, the bank's row, the Plaid asks, and the console.error lines.
// A cell that no longer matches its recorded answer is a behaviour change; the fixture is never edited to match new code.

const encoder = new TextEncoder();

/** A Plaid refusal of one /transactions/sync ask: an ITEM_ERROR (or another type) with the code it names. */
const refusal = (error_type: string, error_code: string): Answer =>
	response({ error_type, error_code, request_id: "request-1" }, 400);

/** A fetch that answers after `ms`, as a late Plaid does. Real timers, so the client's own 30 second timeout is what is tested. */
const late = (ms: number, answer: Answer): Promise<Answer> =>
	new Promise((resolve) => setTimeout(() => resolve(answer), ms));

const noError = () => response({ item: { error: null } });

const refusedItem = () =>
	response(
		{
			error_type: "ITEM_ERROR",
			error_code: "ITEM_LOGIN_REQUIRED",
			request_id: "request-item",
		},
		400,
	);

/** The bank's row for each state, as the item store writes it (the same values as its LANDING table). */
const BANK_STATES = {
	ok: "status = 'ok', attention_login = 0, attention_held = 0",
	login_broken:
		"status = 'needs_attention', attention_login = 1, attention_held = 0",
	needs_relink:
		"status = 'needs_attention', attention_login = 0, attention_held = 1",
	login_broken_and_needs_relink:
		"status = 'needs_attention', attention_login = 1, attention_held = 1",
	disconnected: "disconnected_at = datetime('now')",
} as const;

type Bank = keyof typeof BANK_STATES | "no row";

type Cell = {
	label: string;
	kind: "sync" | "unit" | "webhook";
	/** The bank's state when the check runs (default ok). */
	bank?: Bank;
	/** The Plaid error: the sync's first /transactions/sync answer, or the webhook's ITEM error code. */
	error?: { error_type: string; error_code: string };
	/** Plaid's answer to /item/get when it is not the working or broken login that `loginBroken` gives. */
	itemGet?: PlaidScript["itemGet"];
	/** Whether /item/get says the login is still broken (default false: the login works). */
	loginBroken?: boolean;
	/** A repair, or a lost lease, that lands while Plaid is being asked. */
	during?: "repair" | "lease";
	/** A D1 read of the bank's state, or the write of its login flag, that throws `value`. */
	fault?: { on: "read" | "flag"; value: Thrown };
	/** Unit cells: no TOKEN_ENCRYPTION_KEY, or a stored token that cannot be read. */
	noKey?: boolean;
	unreadableToken?: boolean;
};

const ITEM_LOGIN = {
	error_type: "ITEM_ERROR",
	error_code: "ITEM_LOGIN_REQUIRED",
};

const READ_FAILURE = new Error("the state read failed");
const FLAG_FAILURE = new Error("the flag write failed");

const cells: Cell[] = [
	// The sync: Plaid's error on its first answer, then the check.
	{
		label: "S1 transient PRODUCT_NOT_READY, Plaid says the login is broken",
		kind: "sync",
		error: { error_type: "ITEM_ERROR", error_code: "PRODUCT_NOT_READY" },
		loginBroken: true,
	},
	{
		label:
			"S2 transient TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION as ITEM_ERROR, Plaid says the login is broken",
		kind: "sync",
		error: {
			error_type: "ITEM_ERROR",
			error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
		},
		loginBroken: true,
	},
	{
		label: "S3 another error type (API_ERROR), Plaid says the login is broken",
		kind: "sync",
		error: { error_type: "API_ERROR", error_code: "RATE_LIMIT_EXCEEDED" },
		loginBroken: true,
	},
	{
		label: "S4 ITEM_LOGIN_REQUIRED, Plaid says the login is broken",
		kind: "sync",
		error: ITEM_LOGIN,
		loginBroken: true,
	},
	{
		label: "S5 ITEM_LOGIN_REQUIRED, Plaid's item has no error",
		kind: "sync",
		error: ITEM_LOGIN,
		loginBroken: false,
	},
	{
		label: "S6 ITEM_LOGIN_REQUIRED, Plaid refuses the item lookup",
		kind: "sync",
		error: ITEM_LOGIN,
		itemGet: refusedItem,
	},
	{
		label: "S7 ITEM_LOGIN_REQUIRED, the item lookup's fetch fails",
		kind: "sync",
		error: ITEM_LOGIN,
		itemGet: () => "throws",
	},
	{
		label:
			"S8 ITEM_LOGIN_REQUIRED, Plaid answers the item lookup after 27 seconds with no error",
		kind: "sync",
		error: ITEM_LOGIN,
		itemGet: () => late(27_000, noError()),
	},
	{
		label:
			"S9 ITEM_LOGIN_REQUIRED, Plaid says broken, the bank is login_broken",
		kind: "sync",
		bank: "login_broken",
		error: ITEM_LOGIN,
		loginBroken: true,
	},
	{
		label: "S10 ITEM_LOGIN_REQUIRED, Plaid says broken, the bank needs_relink",
		kind: "sync",
		bank: "needs_relink",
		error: ITEM_LOGIN,
		loginBroken: true,
	},
	{
		label:
			"S11 ITEM_LOGIN_REQUIRED, Plaid says broken, the bank is login_broken_and_needs_relink",
		kind: "sync",
		bank: "login_broken_and_needs_relink",
		error: ITEM_LOGIN,
		loginBroken: true,
	},
	{
		label:
			"S12 ITEM_LOGIN_REQUIRED, Plaid says broken, the bank is disconnected",
		kind: "sync",
		bank: "disconnected",
		error: ITEM_LOGIN,
		loginBroken: true,
	},
	{
		label: "S13 ITEM_LOGIN_REQUIRED, Plaid says broken, the bank has no row",
		kind: "sync",
		bank: "no row",
		error: ITEM_LOGIN,
		loginBroken: true,
	},
	{
		label:
			"S14 ITEM_LOGIN_REQUIRED, Plaid says broken, a repair lands while the item lookup is asked",
		kind: "sync",
		error: ITEM_LOGIN,
		loginBroken: true,
		during: "repair",
	},
	{
		label:
			"S15 ITEM_LOGIN_REQUIRED, Plaid says broken, the sync's lease is lost while the item lookup is asked",
		kind: "sync",
		error: ITEM_LOGIN,
		loginBroken: true,
		during: "lease",
	},
	{
		label: "S16 ITEM_LOGIN_REQUIRED, Plaid says broken, the state read throws",
		kind: "sync",
		error: ITEM_LOGIN,
		loginBroken: true,
		fault: { on: "read", value: READ_FAILURE },
	},
	{
		label:
			"S17 ITEM_LOGIN_REQUIRED, Plaid says broken, the flag's write throws",
		kind: "sync",
		error: ITEM_LOGIN,
		loginBroken: true,
		fault: { on: "flag", value: FLAG_FAILURE },
	},
	// The check on its own, which is how the missing key and an unreadable token reach it (the sync stops earlier for both).
	{ label: "U1 no TOKEN_ENCRYPTION_KEY", kind: "unit", noKey: true },
	{
		label: "U2 the stored token cannot be read",
		kind: "unit",
		unreadableToken: true,
	},
	{
		label: "U3 Plaid says the login is broken",
		kind: "unit",
		loginBroken: true,
	},
	{ label: "U4 Plaid's item has no error", kind: "unit", loginBroken: false },
	{
		label: "U5 Plaid's item lookup fails",
		kind: "unit",
		itemGet: () => "throws",
	},
	// The Plaid webhook's login-error path, through the route.
	{
		label: "W1 ITEM ERROR ITEM_LOGIN_REQUIRED, Plaid says the login is broken",
		kind: "webhook",
		error: ITEM_LOGIN,
		loginBroken: true,
	},
	{
		label: "W2 ITEM ERROR ITEM_LOGIN_REQUIRED, Plaid's item has no error",
		kind: "webhook",
		error: ITEM_LOGIN,
		loginBroken: false,
	},
	{
		label: "W3 ITEM ERROR ITEM_LOGIN_REQUIRED, Plaid refuses the item lookup",
		kind: "webhook",
		error: ITEM_LOGIN,
		itemGet: refusedItem,
	},
	{
		label:
			"W4 ITEM ERROR PRODUCT_NOT_READY (transient), Plaid says broken, the route does not ask",
		kind: "webhook",
		error: { error_type: "ITEM_ERROR", error_code: "PRODUCT_NOT_READY" },
		loginBroken: true,
	},
];

/** The bank's row as the grid names it, or null when there is none. */
async function bankRow(id: number) {
	return env.DB.prepare(
		"SELECT status, attention_login, attention_held, connection_revision, reconnect_emailed_at, disconnected_at, sync_locked_until, sync_lock_id, sync_cursor, sync_update_cursor FROM plaid_items WHERE id = ?",
	)
		.bind(id)
		.first<Record<string, string | number | null>>();
}

/** The fixture names the lock and disconnect fields by whether they are set, not by their values. */
const marker = (value: unknown) => (value === null ? null : "<set>");

type Settled =
	| { kind: "value"; value: unknown }
	| { kind: "threw"; thrown: Thrown }
	| { kind: "hangs" };

/** Long enough for a 27 second answer; the client gives up at 30 seconds, so a run never needs more than that. */
const SECONDS = 40_000;

/** The run's value, the value it threw, or "hangs" when it has not settled in SECONDS. */
async function settle(run: Promise<unknown>): Promise<Settled> {
	let timer: ReturnType<typeof setTimeout> | null = null;

	try {
		return await Promise.race([
			run.then((value): Settled => ({ kind: "value", value })),
			new Promise<Settled>((resolve) => {
				timer = setTimeout(() => resolve({ kind: "hangs" }), SECONDS);
			}),
		]);
	} catch (thrown) {
		// SAFETY: the check, the sync and the route reject with whatever they threw, which the cells' fault values make a Thrown.
		return { kind: "threw", thrown: thrown as Thrown };
	} finally {
		clearTimeout(timer);
	}
}

/** A thrown value as the fixture names it, and whether it is the value a fault injected. */
function describeThrown(thrown: Thrown, injected: Thrown | undefined) {
	const identity =
		injected === undefined
			? "no injected value"
			: Object.is(thrown, injected)
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
		return { kind: thrown.name, message: thrown.message, identity };

	return {
		kind: "not an Error",
		text: JSON.stringify(thrown) ?? String(thrown),
		identity,
	};
}

/** Puts the bank in its state: its flags, a disconnect, or no row at all. */
async function setBank(id: number, bank: Bank) {
	if (bank === "no row") {
		await env.DB.prepare("DELETE FROM plaid_items WHERE id = ?").bind(id).run();

		return;
	}

	if (bank === "ok") return;

	await env.DB.prepare(
		`UPDATE plaid_items SET ${BANK_STATES[bank]} WHERE id = ?`,
	)
		.bind(id)
		.run();
}

/** The Plaid settings the route and the check read, with the key unless the cell has none. */
function envFor(cell: Cell, db: D1Database) {
	return {
		...env,
		DB: db,
		DEMO: "false",
		PLAID_CLIENT_ID: "client",
		PLAID_SECRET: "secret",
		PLAID_ENV: "sandbox",
		TOKEN_ENCRYPTION_KEY: cell.noKey ? undefined : KEY,
	};
}

/**
 * The D1 a cell's fault goes through. The state read is the item store's select of the bank's row (armed once Plaid has
 * refused the sync's first answer, so earlier reads are real); the flag's write is the update that sets login_broken.
 */
function faultyDb(cell: Cell, armed: () => boolean): D1Database {
	if (!cell.fault) return env.DB;

	const { on, value } = cell.fault;

	if (on === "read")
		return failingStatements(
			env.DB,
			(sql) =>
				sql.startsWith("select") &&
				sql.includes('"connection_revision"') &&
				sql.includes('"plaid_items"'),
			value,
			armed,
		);

	return failingStatements(
		env.DB,
		(sql) =>
			sql.startsWith(
				"UPDATE plaid_items SET status = 'needs_attention', attention_login = 1, attention_held = 0",
			),
		value,
		() => true,
	);
}

/** Plaid's script for a cell: the sync's first answer is the error, and /item/get is the login's answer, with what lands during it. */
function scriptFor(cell: Cell, id: number): PlaidScript {
	const errorBody = cell.error ?? ITEM_LOGIN;

	return {
		transactions: () => refusal(errorBody.error_type, errorBody.error_code),
		loginBroken: cell.loginBroken ?? false,
		itemGet: cell.itemGet,
		beforeItemGet: async () => {
			if (cell.during === "repair")
				await env.DB.prepare(
					"UPDATE plaid_items SET status = 'ok', attention_login = 0, attention_held = 0, connection_revision = connection_revision + 1 WHERE id = ?",
				)
					.bind(id)
					.run();

			if (cell.during === "lease")
				await env.DB.prepare(
					"UPDATE plaid_items SET sync_lock_id = 'someone-else' WHERE id = ?",
				)
					.bind(id)
					.run();
		},
	};
}

/** Runs the cell's code path and resolves to what it answered: the sync's result, the check's boolean, or the route's status. */
async function run(
	cell: Cell,
	id: number,
	plaid: ReturnType<typeof scriptedPlaid>,
	runEnv: ReturnType<typeof envFor>,
): Promise<unknown> {
	if (cell.kind === "sync")
		return syncItem(runEnv, id, plaid.fetchImpl, { runAfterSync: false });

	if (cell.kind === "unit") {
		const token = cell.unreadableToken
			? new Uint8Array([1, 2, 3])
			: await encryptToken("secret-access-token", KEY);

		return loginStillBroken(runEnv, token, plaid.fetchImpl);
	}

	return webhookStatus(cell, runEnv, plaid);
}

/** Delivers the webhook for the bank, signed the way Plaid signs one, and answers its status once the route's waits settle. */
async function webhookStatus(
	cell: Cell,
	runEnv: ReturnType<typeof envFor>,
	plaid: ReturnType<typeof scriptedPlaid>,
) {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);

	if (!("privateKey" in pair))
		throw new Error("ECDSA generateKey returns a key pair");

	const b64 = (value: Uint8Array) =>
		btoa(String.fromCharCode(...value))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");

	const json64 = (value: unknown) => b64(encoder.encode(JSON.stringify(value)));

	const kid = crypto.randomUUID();

	const body = JSON.stringify({
		item_id: "item-grid",
		webhook_type: "ITEM",
		webhook_code: "ERROR",
		error: { error_code: (cell.error ?? ITEM_LOGIN).error_code },
	});

	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", encoder.encode(body)),
	);

	const signed = `${json64({ alg: "ES256", kid })}.${json64({
		iat: Math.floor(Date.now() / 1000),
		request_body_sha256: Array.from(digest, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	})}`;

	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			encoder.encode(signed),
		),
	);

	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/webhook_verification_key/get"))
				return Response.json({ key: { ...jwk, expired_at: null } });

			return plaid.fetchImpl(input, init);
		}),
	);

	const promises: Promise<unknown>[] = [];

	const ctx = createExecutionContext();
	ctx.waitUntil = (promise) => {
		promises.push(promise);
	};

	const answer = await app.request(
		"http://tally.test/webhooks/plaid",
		{
			method: "POST",
			body,
			headers: {
				"content-type": "application/json",
				"Plaid-Verification": `${signed}.${b64(signature)}`,
			},
		},
		runEnv,
		ctx,
	);

	await Promise.allSettled(promises);

	return { status: answer.status };
}

async function runCell(cell: Cell) {
	await resetBanks(env.DB);

	const id = await seedBank(env.DB);

	await env.DB.prepare(
		"UPDATE plaid_items SET plaid_item_id = 'item-grid' WHERE id = ?",
	)
		.bind(id)
		.run();

	await setBank(id, cell.bank ?? "ok");

	const plaid = scriptedPlaid(scriptFor(cell, id));

	const db = faultyDb(cell, () => plaid.trace.paths.has("/transactions/sync"));

	const runEnv = envFor(cell, db);

	const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});

	let settled: Settled;
	let errorLines: string[] = [];

	try {
		settled = await settle(run(cell, id, plaid, runEnv));
	} finally {
		errorLines = quiet.mock.calls.map((args) => args.map(String).join(" "));
		quiet.mockRestore();
		log.mockRestore();
		vi.unstubAllGlobals();
	}

	const outcome =
		settled.kind === "hangs"
			? { hangs: true }
			: settled.kind === "threw"
				? { threw: describeThrown(settled.thrown, cell.fault?.value) }
				: { returned: settled.value };

	const row = await bankRow(id);

	const charges = await env.DB.prepare(
		"SELECT plaid_transaction_id, amount_cents FROM transactions ORDER BY plaid_transaction_id",
	).all();

	return {
		...outcome,
		bank: row
			? {
					status: row.status,
					attention_login: row.attention_login,
					attention_held: row.attention_held,
					connection_revision: row.connection_revision,
					reconnect_emailed_at: marker(row.reconnect_emailed_at),
					disconnected_at: marker(row.disconnected_at),
					sync_locked_until: marker(row.sync_locked_until),
					sync_lock_id: marker(row.sync_lock_id),
					sync_cursor: row.sync_cursor,
					sync_update_cursor: row.sync_update_cursor,
				}
			: null,
		charges: charges.results,
		asks: Object.fromEntries(plaid.trace.paths),
		cursors: plaid.trace.cursors,
		consoleErrors: errorLines,
	};
}

describe("the login check after a login error (#1192, step 1)", () => {
	it("gives every cell the answer recorded for it before the check moved", async () => {
		const answers: Record<string, unknown> = {};

		for (const cell of cells) answers[cell.label] = await runCell(cell);

		expect(Object.keys(answers).sort()).toEqual(Object.keys(recorded).sort());
		expect(answers).toEqual(recorded);
	}, 900_000);
});
