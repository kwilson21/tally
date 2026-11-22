// Scripted Plaid and a D1 whose one save fails, for the sync's page errors (#1164, step 2). Plaid answers each
// /transactions/sync ask by its number, so a case can script a second page, a restart or a refusal; /accounts/get
// answers one good account; /item/get answers a login that works, or one that is still broken. A save is one D1 batch
// (one per page), so the failing save is the batch with that number. Every other statement is the real one.

import { vi } from "vitest";
import { saveAiSwitches } from "../../src/db/ai-switches";
import type { Json } from "../../src/json";
import { encryptToken } from "../../src/plaid/token-crypto";
import { GOOD_ACCOUNT, GOOD_PAGE, GOOD_TRANSACTION } from "../sync-page-corpus";
import { forwardMember } from "./present";

/** A value a sync can throw: an Error (a Plaid error is one), or a value a save rejected with, which may be any of these. */
export type Thrown = Error | string | number | null | undefined;

export const KEY = btoa("01234567890123456789012345678901");

export const ITEM_ERROR = {
	error_type: "ITEM_ERROR",
	error_code: "ITEM_LOGIN_REQUIRED",
	error_message: "the login needs attention",
	request_id: "request-1",
};

/** Plaid's answer when an update changed while it was being paged. */
export const MUTATION = {
	error_type: "TRANSACTIONS_ERROR",
	error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
	request_id: "request-mutation",
};

export const response = (body: Json, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** A page of one charge, with the cursor it names and whether more pages follow it. Each call makes a new Response. */
export const page = (transaction: string, next: string, more: boolean) =>
	response({
		...GOOD_PAGE,
		added: [{ ...GOOD_TRANSACTION, transaction_id: transaction }],
		next_cursor: next,
		has_more: more,
	});

/** One /transactions/sync answer: a Response, or "throws" for a fetch that fails. */
export type Answer = Response | "throws";

export type PlaidScript = {
	/** The answer to the `call`th /transactions/sync ask (counted from 1), given the cursor it was asked at. */
	transactions: (call: number, cursor: string | null) => Answer;
	/** Whether /item/get says the login is still broken. */
	loginBroken: boolean;
};

/** What the scripted Plaid was asked: the paths with their counts, and the cursor of each /transactions/sync ask. */
export type PlaidTrace = { paths: Map<string, number>; cursors: string[] };

export function scriptedPlaid(script: PlaidScript) {
	const trace: PlaidTrace = { paths: new Map(), cursors: [] };

	const fetchImpl = vi.fn(
		async (url: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;

			trace.paths.set(path, (trace.paths.get(path) ?? 0) + 1);

			if (path === "/accounts/get")
				return response({ accounts: [GOOD_ACCOUNT] });

			if (path === "/transactions/sync") {
				// The sync sends a JSON body with at most a cursor, and this file built every body it reads here.
				const body: { cursor?: string } = JSON.parse(
					String(init?.body ?? "{}"),
				);

				const cursor = body.cursor ?? null;

				trace.cursors.push(cursor ?? "(none)");

				const answer = script.transactions(trace.cursors.length, cursor);

				if (answer === "throws")
					throw new TypeError("fetch failed: the network is down");

				return answer;
			}

			return response({
				item: { error: script.loginBroken ? ITEM_ERROR : null },
			});
		},
	);

	return { fetchImpl, trace };
}

/** The D1 with its `nth` batch (counted from 1) rejected with `failure` before it runs: a page's save, which writes nothing. */
export function failingSave(
	base: D1Database,
	nth: number,
	failure: Thrown,
): D1Database {
	let batches = 0;

	return new Proxy(base, {
		get(target, prop) {
			if (prop !== "batch") return forwardMember(target, prop);

			return (statements: D1PreparedStatement[]) => {
				batches += 1;

				if (batches === nth) return Promise.reject(failure);

				return target.batch(statements);
			};
		},
	});
}

/** Empties the bank tables and sets the sync's switches, as the lease grid does before each cell. */
export async function resetBanks(db: D1Database) {
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM accounts"),
		db.prepare("DELETE FROM plaid_items"),
		db.prepare("DELETE FROM merchant_suggested_names"),
		db.prepare("DELETE FROM merchants"),
	]);

	await saveAiSwitches(db, { details: false });
}

/** A bank with a working login and no lease, as a fresh row. Returns its id. */
export async function seedBank(db: D1Database): Promise<number> {
	const row = await db
		.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
		)
		.bind(await encryptToken("secret-access-token", KEY), crypto.randomUUID())
		.first<{ id: number }>();

	if (!row) throw new Error("the test bank was not inserted");

	return row.id;
}
