import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { syncItem } from "../src/plaid/sync";
import { encryptToken } from "../src/plaid/token-crypto";
import { GOOD_ACCOUNT, GOOD_PAGE, GOOD_TRANSACTION } from "./sync-page-corpus";

// A page that says more is coming and leaves out next_cursor, while it drops a pending charge that is waiting for the
// update's last page, is taken by the sync: the position it saves is the held one, so next_cursor is never read. The
// Schema read once refused it, which would have stalled that bank's cursor (#1152, found by the verifier of #1170).

const KEY = btoa("01234567890123456789012345678901");

async function addBank() {
	const row = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, 'Bank', 'person@example.com', ?) RETURNING id",
	)
		.bind(await encryptToken("secret-access-token", KEY), crypto.randomUUID())
		.first<{ id: number }>();

	return row?.id ?? 0;
}

/** Runs one sync of the bank, giving Plaid's pages in turn. */
async function syncPages(id: number, pages: object[]) {
	let asked = 0;

	const fetchImpl = vi.fn(
		async (url: RequestInfo | URL, _init?: RequestInit) => {
			if (String(url).endsWith("/accounts/get"))
				return new Response(JSON.stringify({ accounts: [GOOD_ACCOUNT] }));

			const page = pages[Math.min(asked, pages.length - 1)];
			asked += 1;

			return new Response(JSON.stringify(page));
		},
	);

	const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
	const log = vi.spyOn(console, "log").mockImplementation(() => {});

	try {
		await syncItem({ ...env, TOKEN_ENCRYPTION_KEY: KEY }, id, fetchImpl, {
			runAfterSync: false,
		});
	} finally {
		quiet.mockRestore();
		log.mockRestore();
	}

	return asked;
}

describe("a page that says more is coming and has no next_cursor (#1152)", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM accounts"),
			env.DB.prepare("DELETE FROM plaid_items"),
			env.DB.prepare("DELETE FROM merchant_suggested_names"),
			env.DB.prepare("DELETE FROM merchants"),
		]);
		await saveAiSwitches(env.DB, { details: false });
	});

	it("is taken when it drops a pending charge that is waiting, and the last page ends the run", async () => {
		const id = await addBank();

		await syncPages(id, [
			{
				...GOOD_PAGE,
				added: [
					{ ...GOOD_TRANSACTION, transaction_id: "pend-1", pending: true },
				],
			},
		]);

		await env.DB.prepare(
			"UPDATE plaid_items SET last_sync_attempt_at = NULL WHERE id = ?",
		)
			.bind(id)
			.run();

		const asked = await syncPages(id, [
			{
				added: [],
				modified: [],
				removed: [{ transaction_id: "pend-1" }],
				has_more: true,
			},
			{
				added: [],
				modified: [],
				removed: [],
				next_cursor: "c2",
				has_more: false,
			},
		]);

		expect(asked).toBe(2);

		expect(
			await env.DB.prepare("SELECT sync_cursor FROM plaid_items WHERE id = ?")
				.bind(id)
				.first(),
		).toEqual({ sync_cursor: "c2" });

		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE plaid_transaction_id = 'pend-1'",
			).first(),
		).toEqual({ n: 0 });
	});
});
