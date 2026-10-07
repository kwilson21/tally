import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { bankSyncs } from "../src/db/accounts";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";

// Home's picked bank alert (decision 82, P96): a connected bank that needs attention or hasn't synced
// for 3 days gets an as-of tag and a soft alert line with Fix before the forecast.
// Only Date is faked: the Workers runtime and D1 keep their real timers. Noon Eastern on Oct 7.
const NOW = "2026-10-07T16:00:00Z";
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
		expect(html).not.toContain("Fix the bank in Accounts");
	});

	it("shows for a bank that needs attention, in the sign-in words", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		const { res, html } = await page();
		expect(res.status).toBe(200);
		expect(textOf(html)).toContain(`${FIRST} needs signing in`);
	});

	it("shows each affected bank on its own line, oldest first, with one Fix and the oldest date", async () => {
		await setBank(FIRST, {
			status: "needs_attention",
			syncedAt: "2026-10-01 06:00:00",
		});
		await setBank(SECOND, { syncedAt: "2026-09-20 06:00:00" });
		const { html } = await page();
		expect(html).toContain(
			"<li>Northline Card Services stopped updating Sep 20</li>",
		);
		expect(html).toContain("<li>First Harbor Bank needs signing in</li>");
		expect(
			html.indexOf("Northline Card Services stopped updating Sep 20"),
		).toBeLessThan(html.indexOf("First Harbor Bank needs signing in"));
		expect(html).toContain("as of Sep 20");
		expect(
			html.match(
				/<div class="mt-3 flex items-center[\s\S]*?data-icon="bank"/g,
			) ?? [],
		).toHaveLength(1);
		expect(
			html.match(/Fix<span class="sr-only"> the bank in Accounts<\/span>/g),
		).toHaveLength(1);
	});

	it("shows a soft alert after status and before the forecast, with Fix to Accounts", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		const { html } = await page();
		const at = (s: string) => html.indexOf(s);
		const line = at(`${FIRST} needs signing in`);
		expect(line).toBeGreaterThan(at("Everything else is on track."));
		const forecast = at('aria-label="Spending in Oct');
		expect(line).toBeLessThan(forecast);
		expect(forecast).toBeLessThan(at("How this works"));
		const block = html.slice(line - 600, forecast);
		expect(block).toContain('data-icon="bank"');
		expect(block).toContain("bg-over/10");
		expect(block).toMatch(
			/href="\/accounts"[^>]*>Fix<span class="sr-only"> the bank in Accounts/,
		);
	});

	it("does not flag a bank that synced 2 days ago", async () => {
		await setBank(FIRST, { syncedAt: "2026-10-05 06:00:00" });
		const { html } = await page();
		expect(html).not.toContain("as of Oct 5");
	});

	it("flags a bank that last synced 3 days ago, since that day", async () => {
		await setBank(FIRST, { syncedAt: "2026-10-04 06:00:00" });
		const { html } = await page();
		expect(textOf(html)).toContain(`${FIRST} stopped updating Oct 4`);
		expect(html).toContain("as of Oct 4");
	});

	it("counts 3 days from the household's today, not UTC's", async () => {
		// 02:00 UTC on Oct 6 is 22:00 Eastern on Oct 5: Oct 3 is 2 days back, though 3 from UTC's Oct 6.
		vi.setSystemTime(new Date("2026-10-06T02:00:00Z"));
		await setBank(FIRST, { syncedAt: "2026-10-03 06:00:00" });
		expect((await page()).html).not.toContain("as of Oct 3");
		vi.setSystemTime(new Date("2026-10-06T05:00:00Z"));
		expect(textOf((await page()).html)).toContain(
			`${FIRST} stopped updating Oct 3`,
		);
	});

	it("uses the sign-in words when a bank both needs it and hasn't synced", async () => {
		await setBank(FIRST, {
			status: "needs_attention",
			syncedAt: "2026-09-01 06:00:00",
		});
		const text = textOf((await page()).html);
		expect(text).toContain(`${FIRST} needs signing in`);
		expect(text).not.toContain("stopped updating");
	});

	it("does not flag a disconnected bank", async () => {
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now'), status = 'needs_attention', last_synced_at = '2026-09-01 06:00:00' WHERE institution_name = ?",
		)
			.bind(FIRST)
			.run();
		const { html } = await page();
		expect(html).not.toContain("Fix the bank in Accounts");
	});

	it("names the oldest bank when two are stale", async () => {
		await setBank(FIRST, { syncedAt: "2026-10-02 06:00:00" });
		await setBank(SECOND, { syncedAt: "2026-09-20 06:00:00" });
		const text = textOf((await page()).html);
		expect(text).toContain(`${SECOND} stopped updating Sep 20`);
		expect(text).toContain(`${FIRST} stopped updating Oct 2`);
		expect(text).toContain("as of Sep 20");
		expect(text.indexOf(`${SECOND} stopped updating Sep 20`)).toBeLessThan(
			text.indexOf(`${FIRST} stopped updating Oct 2`),
		);
		expect(text.match(/Fix\s+the bank in Accounts/g)).toHaveLength(1);
	});

	it("names the bank that needs signing in and keeps the oldest date", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		await setBank(SECOND, { syncedAt: "2026-09-20 06:00:00" });
		const text = textOf((await page()).html);
		expect(text).toContain(`${SECOND} stopped updating Sep 20`);
		expect(text).toContain(`${FIRST} needs signing in`);
		expect(text).toContain("as of Sep 20");
	});

	it("goes away once the bank is fixed or syncs again", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		expect((await page()).html).toContain("needs signing in");
		await setBank(FIRST, { status: "ok" });
		expect((await page()).html).not.toContain("needs signing in");

		await setBank(FIRST, { syncedAt: "2026-09-20 06:00:00" });
		expect((await page()).html).toContain("stopped updating Sep 20");
		await setBank(FIRST, { syncedAt: "2026-10-05 15:00:00" });
		expect((await page()).html).not.toContain("stopped updating");
	});

	it("is on a budget sheet's Home too, so it isn't hidden by opening one", async () => {
		await setBank(FIRST, { status: "needs_attention" });
		const res = await home.request("/budget/1", {}, family);
		expect(textOf(await res.text())).toContain("needs signing in");
	});

	it("never shows in the demo, whatever its banks say", async () => {
		await setBank(FIRST, {
			status: "needs_attention",
			syncedAt: "2026-09-01 06:00:00",
		});
		await setBank(SECOND, { syncedAt: "2026-09-01 06:00:00" });
		const { res, html } = await page(demo);
		expect(res.status).toBe(200);
		expect(html).not.toContain("needs signing in");
		expect(html).not.toContain("Fix the bank in Accounts");
	});
});
