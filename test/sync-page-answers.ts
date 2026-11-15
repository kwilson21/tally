// What each sync page case answers, as one string: the real syncItem run on the case, with Plaid stood in for by a fetch
// that gives the case's accounts and page. The answer says whether the sync ended or failed, what the bank's row, its
// accounts and its charges hold afterwards, and how often Plaid was asked. A failure answers only that it failed: its error's
// class and message are not part of the answer, since a message can hold what Plaid sent. Shared by the characterise test and
// the baseline recorder (#1152).

import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import {
	GOOD_ACCOUNT,
	GOOD_PAGE,
	GOOD_TRANSACTION,
	type SyncCase,
} from "./sync-page-corpus";

const KEY = btoa("01234567890123456789012345678901");

const SECONDS = 20_000;

/** The case's accounts text and page text, with the good ones filled in for what it leaves out. */
function bodies(item: SyncCase) {
	const accounts =
		item.accounts ?? JSON.stringify({ accounts: [GOOD_ACCOUNT] });

	const charge = item.transaction ?? GOOD_TRANSACTION;

	const page =
		item.page ??
		JSON.stringify({
			...GOOD_PAGE,
			added: item.modified ? [] : [charge],
			modified: item.modified ? [charge] : [],
		});

	return { accounts, page };
}

/** A stored text over 200 characters is told by its length and start, so the fixture stays small. */
const short = (column: string) =>
	`CASE WHEN LENGTH(${column}) > 200 THEN 'long ' || LENGTH(${column}) || ' ' || SUBSTR(${column}, 1, 20) ELSE ${column} END AS ${column}`;

export async function answerOf(item: SyncCase): Promise<string> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchant_suggested_names"),
		env.DB.prepare("DELETE FROM merchants"),
	]);
	await saveAiSwitches(env.DB, { details: false });

	const row = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(await encryptToken("secret-access-token", KEY), crypto.randomUUID())
		.first<{ id: number }>();

	const id = row?.id ?? 0;
	const { accounts, page } = bodies(item);
	let pageAsks = 0;

	const fetchImpl = vi.fn(
		async (url: RequestInfo | URL, _init?: RequestInit) => {
			if (String(url).endsWith("/accounts/get")) return new Response(accounts);

			pageAsks += 1;

			return new Response(page);
		},
	);

	const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	let ended = "ends";

	try {
		await Promise.race([
			syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl, {
				runAfterSync: false,
			}),
			new Promise((_resolve, reject) =>
				setTimeout(() => reject(new Error("hangs")), SECONDS),
			),
		]);
	} catch (error) {
		ended =
			error instanceof Error && error.message === "hangs" ? "hangs" : "fails";
	} finally {
		quiet.mockRestore();
		log.mockRestore();
	}

	const bank = await env.DB.prepare(
		"SELECT sync_cursor, status FROM plaid_items WHERE id = ?",
	)
		.bind(id)
		.first();

	const stored = await env.DB.prepare(
		`SELECT plaid_account_id, ${short("name")}, ${short("mask")}, type, subtype, is_liability, balance_cents FROM accounts ORDER BY id`,
	).all();

	const charges = await env.DB.prepare(
		`SELECT plaid_transaction_id, date, amount_cents, ${short("raw_name")}, ${short("merchant_name")}, pending, plaid_category, plaid_detailed_category FROM transactions ORDER BY id`,
	).all();

	return `${ended} | ${JSON.stringify(bank)} | accounts ${JSON.stringify(stored.results)} | charges ${JSON.stringify(charges.results)} | page asks ${pageAsks}`;
}
