import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { bankSyncs } from "../src/db/accounts";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";

// The stale-bank line on Home (spec §8.5, decision 72 P37 A): a connected bank that needs attention or
// hasn't synced for 3 days is flagged under the status sentence, before the Band, with a link to Accounts.
// Only Date is faked: the Workers runtime and D1 keep their real timers. Noon Eastern on Oct 5.
const NOW = "2026-10-05T16:00:00Z";
const family = { ...env, DEMO: "false" } as unknown as Env;
const demo = { ...env, DEMO: "true" } as unknown as Env;

async function page(bindings: Env = family) {
	const res = await home.request("/", {}, bindings);
	return { res, html: await res.text() };
}
/** The page's text, without markup. */
const textOf = (html: string) =>
	html.replace(/<[^>]+>/g, " ").replaceAll("&#39;", "'");

const FIRST = "First Harbor Bank";
const SECOND = "Northline Card Services";
const setBank = (
	name: string,
	{ status, syncedAt }: { status?: string; syncedAt?: string | null },
) =>
	env.DB.prepare(
		"UPDATE plaid_items SET status = COALESCE(?, status), last_synced_at = CASE WHEN ? THEN ? ELSE last_synced_at END WHERE institution_name = ?",
	)
		.bind(
			status ?? null,
			syncedAt === undefined ? 0 : 1,
			syncedAt ?? null,
			name,
		)
		.run();

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	// Both banks synced this morning; each test then breaks what it needs to.
	await setBank(FIRST, { syncedAt: "2026-10-05 12:00:00" });
	await setBank(SECOND, { syncedAt: "2026-10-05 12:00:00" });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("bankSyncs", () => {
	it("reads each bank's status and last sync from plaid_items alone, in the order linked", async () => {
		await setBank(SECOND, { status: "needs_attention" });
		await env.DB.prepare(
			"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, disconnected_at) VALUES (X'00', 'Old Bank', 'person', datetime('now'))",
		).run();
		expect(await bankSyncs(env.DB)).toEqual([
			{
				name: FIRST,
				needsAttention: false,
				lastSyncedAt: "2026-10-05 12:00:00",
				disconnected: false,
			},
			{
				name: SECOND,
				needsAttention: true,
				lastSyncedAt: "2026-10-05 12:00:00",
				disconnected: false,
			},
			{
				name: "Old Bank",
				needsAttention: false,
				lastSyncedAt: null,
				disconnected: true,
			},
		]);
	});
});

describe("Home's stale-bank line", () => {
	it("is not there when every bank is healthy and synced", async () => {
		const { html } = await page();
		expect(html).not.toContain("Safe to spend may be too high");
		expect(html).not.toContain("Check Accounts");
	});

	it("shows for a bank that needs attention, in the sign-in words", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		const { res, html } = await page();
		expect(res.status).toBe(200);
		expect(textOf(html)).toContain(
			`${FIRST} needs you to sign in again, so Safe to spend may be too high.`,
		);
	});

	it("sits between the status sentence and the Band, with the alert icon and a link to Accounts", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		const { html } = await page();
		const at = (s: string) => html.indexOf(s);
		const line = at("needs you to sign in again");
		expect(line).toBeGreaterThan(at("Everything else is on track."));
		expect(line).toBeLessThan(at("transactions need"));
		// The icon comes with the words, so it isn't color alone, and the words are ink, not brick.
		const block = html.slice(at("How this works"), at("transactions need"));
		expect(block).toContain("<svg");
		expect(block).toContain('aria-hidden="true"');
		expect(block).not.toContain("text-over");
		expect(block).toMatch(
			/<a href="\/accounts"[^>]*class="[^"]*min-h-11[^"]*"[^>]*>\s*Check Accounts\s*<\/a>/,
		);
	});

	it("does not flag a bank that synced 2 days ago", async () => {
		await setBank(FIRST, { syncedAt: "2026-10-03 06:00:00" });
		const { html } = await page();
		expect(html).not.toContain("Safe to spend may be too high");
	});

	it("flags a bank that last synced 3 days ago, since that day", async () => {
		await setBank(FIRST, { syncedAt: "2026-10-02 06:00:00" });
		const { html } = await page();
		expect(textOf(html)).toContain(
			`${FIRST} hasn't synced since Oct 2, so Safe to spend may be too high.`,
		);
	});

	it("counts 3 days from the household's today, not UTC's", async () => {
		// 02:00 UTC on Oct 6 is 22:00 Eastern on Oct 5: Oct 3 is 2 days back, though 3 from UTC's Oct 6.
		vi.setSystemTime(new Date("2026-10-06T02:00:00Z"));
		await setBank(FIRST, { syncedAt: "2026-10-03 06:00:00" });
		expect((await page()).html).not.toContain("Safe to spend may be too high");
		vi.setSystemTime(new Date("2026-10-06T05:00:00Z"));
		expect(textOf((await page()).html)).toContain(
			`${FIRST} hasn't synced since Oct 3`,
		);
	});

	it("uses the sign-in words when a bank both needs it and hasn't synced", async () => {
		await setBank(FIRST, {
			status: "needs_attention",
			syncedAt: "2026-09-01 06:00:00",
		});
		const text = textOf((await page()).html);
		expect(text).toContain(`${FIRST} needs you to sign in again`);
		expect(text).not.toContain("hasn't synced since");
	});

	it("does not flag a disconnected bank", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now'), status = 'needs_attention', last_synced_at = '2026-09-01 06:00:00' WHERE institution_name = ?",
		)
			.bind(FIRST)
			.run();
		const { html } = await page();
		expect(html).not.toContain("Safe to spend may be too high");
	});

	it("names the first bank and counts the rest when two are flagged", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		await setBank(SECOND, { syncedAt: "2026-09-20 06:00:00" });
		const text = textOf((await page()).html);
		expect(text).toContain(
			`${FIRST} needs you to sign in again, and 1 other bank needs a look, so Safe to spend may be too high.`,
		);
		expect(text).not.toContain(SECOND);
		expect(text.match(/Check Accounts/g)).toHaveLength(1);
	});

	it("goes away once the bank is fixed or syncs again", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		expect((await page()).html).toContain("Safe to spend may be too high");
		await setBank(FIRST, { status: "ok" });
		expect((await page()).html).not.toContain("Safe to spend may be too high");

		await setBank(FIRST, { syncedAt: "2026-09-20 06:00:00" });
		expect((await page()).html).toContain("Safe to spend may be too high");
		await setBank(FIRST, { syncedAt: "2026-10-05 15:00:00" });
		expect((await page()).html).not.toContain("Safe to spend may be too high");
	});

	it("is on a budget sheet's Home too, so it isn't hidden by opening one", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		const res = await home.request("/budget/1", {}, family);
		expect(textOf(await res.text())).toContain("needs you to sign in again");
	});

	it("never shows in the demo, whatever its banks say", async () => {
		await setBank(FIRST, {
			status: "needs_attention",
			syncedAt: "2026-09-01 06:00:00",
		});
		await setBank(SECOND, { syncedAt: "2026-09-01 06:00:00" });
		const { res, html } = await page(demo);
		expect(res.status).toBe(200);
		expect(html).not.toContain("Safe to spend may be too high");
		expect(html).not.toContain("Check Accounts");
	});
});
