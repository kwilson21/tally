import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";

// Home's Apple Card line (spec §8.10, decision 138): seven household days after its last upload, Home says so with an
// Upload link to Accounts' upload sheet, and the as-of tag takes the earlier of that upload's day and a bank's sync day.
// Only Date is faked, as in home-bank-line.test.ts. Noon Eastern on Oct 7.
const NOW = "2026-10-07T16:00:00Z";
const family = { ...env, DEMO: "false" } as unknown as Env;
const demo = { ...env, DEMO: "true" } as unknown as Env;

async function page(path = "/", bindings: Env = family) {
	const res = await home.request(path, {}, bindings);
	return { res, html: await res.text() };
}
/** The page's text, without markup. */
const textOf = (html: string) =>
	html.replace(/<[^>]+>/g, " ").replaceAll("&#39;", "'");

const FIRST = "First Harbor Bank";
const LINE = "Apple Card hasn't been updated since";
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

/** Adds the household's Apple Card as an upload leaves it: its balance typed, uploaded on `uploadedOn` (apple-card-net-worth.test.ts). */
async function addCard(uploadedOn: string, removedAt: string | null = null) {
	await env.DB.prepare(
		`INSERT INTO accounts (name, type, subtype, is_liability, balance_cents, balance_on, counted_from, uploaded_on, removed_at)
		VALUES ('Apple Card', 'credit', 'apple_card', 1, ?, ?, ?, ?, ?)`,
	)
		.bind(124000, uploadedOn, uploadedOn, uploadedOn, removedAt)
		.run();
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	// A household that has finished its first week (the demo's budgets, as migration 0057 marks them): no setup shows.
	await env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
	)
		.bind(
			JSON.stringify({
				strokes: {
					bank: null,
					pay: null,
					bills: null,
					budgets: null,
					count: null,
				},
				budgets: {},
			}),
		)
		.run();
	// Both banks synced this morning; each test then breaks what it needs to.
	await setBank(FIRST, { syncedAt: "2026-10-05 12:00:00" });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Home's Apple Card line", () => {
	it("shows once 7 household days have passed since the upload, dated by it, with Upload to the upload sheet", async () => {
		await addCard("2026-09-30");
		const { res, html } = await page();
		expect(res.status).toBe(200);
		expect(textOf(html)).toContain(`${LINE} Sep 30`);
		expect(html).toContain("as of Sep 30");
		expect(html).toMatch(
			/<a href="\/accounts\/apple-card" class="[^"]*min-h-11[^"]*">Upload<span class="sr-only"> an Apple Card file in Accounts<\/span><\/a>/,
		);
		expect(html.match(/data-icon="card"/g) ?? []).toHaveLength(1);
	});

	it("is not there, nor an as-of tag, at 6 days", async () => {
		await addCard("2026-10-01");
		const { html } = await page();
		expect(html).not.toContain("Apple Card");
		expect(html).not.toMatch(/as of [A-Z][a-z]{2} \d/);
		expect(html).not.toContain('href="/accounts/apple-card"');
	});

	it("is not there once removed", async () => {
		await addCard("2026-09-30", "2026-10-02 09:00:00");
		const { html } = await page();
		expect(html).not.toContain("Apple Card");
		expect(html).not.toMatch(/as of [A-Z][a-z]{2} \d/);
	});

	it("is not there in a past month", async () => {
		await addCard("2026-09-30");
		const { res, html } = await page("/?month=2026-09");
		expect(res.status).toBe(200);
		expect(html).not.toContain("Apple Card");
		expect(html).not.toMatch(/as of [A-Z][a-z]{2} \d/);
	});

	it("is not there in the demo, whatever the card says", async () => {
		await addCard("2026-09-30");
		const { res, html } = await page("/", demo);
		expect(res.status).toBe(200);
		expect(html).not.toContain("Apple Card");
		expect(html).not.toContain('href="/accounts/apple-card"');
	});

	it("comes after a bank's line, and the as-of tag takes the earlier date: the bank's", async () => {
		await setBank(FIRST, { syncedAt: "2026-09-25 06:00:00" });
		await addCard("2026-09-30");
		const { html } = await page();
		const text = textOf(html);
		expect(text).toContain(`${FIRST} stopped updating Sep 25`);
		expect(text).toContain(`${LINE} Sep 30`);
		expect(text.indexOf(`${FIRST} stopped updating Sep 25`)).toBeLessThan(
			text.indexOf(LINE),
		);
		expect(html).toContain("as of Sep 25");
		expect(html).not.toContain("as of Sep 30");
	});

	it("takes the earlier date when Apple Card's upload is the older one", async () => {
		await setBank(FIRST, { syncedAt: "2026-10-03 06:00:00" });
		await addCard("2026-09-30");
		const { html } = await page();
		expect(textOf(html)).toContain(`${FIRST} stopped updating Oct 3`);
		expect(textOf(html)).toContain(`${LINE} Sep 30`);
		expect(html).toContain("as of Sep 30");
	});
});
