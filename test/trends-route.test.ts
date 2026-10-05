import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMonth } from "../src/budget";
import {
	DEFAULT_TIME_ZONE,
	monthName,
	monthsBefore,
	todayIn,
} from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { formatCents } from "../src/money";
import { trends } from "../src/routes/trends";
import { sameDaysCaption } from "../src/trends";

const get = async (path: string) => {
	const res = await exports.default.fetch(`http://tally.test${path}`);
	return { res, html: await res.text() };
};
const notDemo = { ...env, DEMO: "false" } as unknown as Env;
/** One list on the page: its `<section>` by the id its heading carries. */
const section = (html: string, id: string) =>
	html.match(
		new RegExp(`<section aria-labelledby="${id}-title">[\\s\\S]*?</section>`),
	)?.[0] ?? "";
const text = (html: string) =>
	html
		.replace(/<svg[\s\S]*?<\/svg>/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");

const at = (instant: string) => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(instant));
};

afterEach(() => {
	vi.useRealTimers();
});

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
});

describe("GET /trends with the demo seed", () => {
	it("renders inside the shell with Trends as the current page", async () => {
		const { res, html } = await get("/trends");
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Trends · Tally</title>");
		expect(html).toMatch(/<h1[^>]*>Trends<\/h1>/);
		expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?Trends/);
	});

	it("leads with what's spent so far as the serif number, equal to Home's total spent", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const month = today.slice(0, 7);
		const data = await loadMonth(env.DB, month);
		const home = summarizeMonth({ month, ...data, unpaidDueBillsCents: 0 });
		const { html } = await get("/trends");
		const spent = formatCents(home.totalSpentCents, { wholeDollars: true });
		expect(html).toContain(`Spent so far in ${monthName(month)}`);
		expect(html).toMatch(
			new RegExp(
				`Spent so far in ${monthName(month)}</p><p class="font-serif[^"]*">\\${spent}</p>`,
			),
		);
	});

	it("says in words how it compares with the same days last month, written by code", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const lastMonth = monthName(monthsBefore(today.slice(0, 7), 1));
		const { html } = await get("/trends");
		expect(text(html)).toMatch(
			new RegExp(
				`(\\$[\\d,]+ (less|more) than|About the same as) by this time in ${lastMonth}\\.`,
			),
		);
		expect(html).toContain(sameDaysCaption(today));
	});

	it("shows each category's change with an arrow and words, biggest first", async () => {
		const { html } = await get("/trends");
		const changes = section(html, "changes");
		const words = [...changes.matchAll(/(Up|Down) \$([\d,.]+)/g)];
		expect(words.length).toBeGreaterThan(2);
		const sizes = words.map((m) => Number((m[2] ?? "").replaceAll(",", "")));
		expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
		// Money with no category has its own row, in Home's words.
		expect(changes).toContain("Needs a category");
		expect(changes).not.toContain("Uncategorized");
		// An arrow beside each (decorative: the words carry it).
		expect(
			changes.match(/<svg[^>]*aria-hidden="true"/g)?.length,
		).toBeGreaterThanOrEqual(words.length);
	});

	it("shows the demo's story: Going well, Worth a look, then every other category", async () => {
		const { html } = await get("/trends");
		const names = (id: string) =>
			[...section(html, id).matchAll(/text-lg leading-6">([^<]+)</g)].map(
				(m) => m[1],
			);
		expect(names("going-well")).toEqual(["Groceries", "Gas", "Household"]);
		expect(text(section(html, "going-well"))).toContain(
			"4 months under budget",
		);
		expect(names("worth-a-look")).toEqual(["Eating Out"]);
		expect(text(section(html, "worth-a-look"))).toContain(
			"Up 3 months running",
		);
		expect(names("others")).toEqual(["Kids"]);
		expect(text(section(html, "others"))).toMatch(/\$\d+ in /);
		expect(text(html)).toContain("Every other category, ");
		// In that order on the page.
		expect(html.indexOf("Going well")).toBeLessThan(
			html.indexOf("Worth a look"),
		);
		expect(html.indexOf("Worth a look")).toBeLessThan(
			html.indexOf("Every other category"),
		);
	});

	it("gives each row six small bars, the last dashed, and the amounts in words", async () => {
		const { html } = await get("/trends");
		const row = section(html, "worth-a-look").match(
			/<svg[^>]*role="img"[^>]*>[\s\S]*?<\/svg>/,
		)?.[0];
		expect(row).toBeDefined();
		expect(row?.match(/<rect/g)).toHaveLength(6);
		expect(row?.match(/stroke-dasharray/g)).toHaveLength(1);
		const label = row?.match(/aria-label="([^"]*)"/)?.[1] ?? "";
		expect(label).toMatch(
			/^Spending by month: \w+ \$[\d,]+, \w+ \$[\d,]+, \w+ \$[\d,]+, \w+ \$[\d,]+, \w+ \$[\d,]+, \w+ so far \$[\d,]+\.$/,
		);
		// Bars use tokens and attributes only: the CSP forbids style attributes.
		expect(html).not.toMatch(/<svg[^>]*\sstyle=/);
	});

	it("explains the rules with Why? and How this works links to the Trends section", async () => {
		const { html } = await get("/trends");
		for (const topic of [
			"this month against last",
			"going well",
			"worth a look",
		]) {
			expect(html).toMatch(
				new RegExp(
					`<a href="/how-it-works#trends" aria-label="Why\\? ${topic}"[^>]*min-h-11`,
				),
			);
		}
		expect(html).toContain('aria-label="How this works: trends"');
	});

	it("sends every Why? and How this works link to a section of How Tally works that exists", async () => {
		const { html } = await get("/trends");
		const targets = new Set(
			[...html.matchAll(/href="\/how-it-works#([a-z]+)"/g)].map((m) => m[1]),
		);
		expect([...targets]).toEqual(["trends"]);
		const how = (await get("/how-it-works")).html;
		for (const id of targets)
			expect(how).toMatch(new RegExp(`<section[^>]*id="${id}"`));
	});

	it("never names Jev", async () => {
		const { html } = await get("/trends");
		expect(html).not.toMatch(/jev/i);
	});
});

describe("the household's today (decision 67)", () => {
	// 03:30 UTC on Nov 1 is 23:30 Eastern on Oct 31.
	it("is still October at 23:30 Eastern on Oct 31, comparing with all of September", async () => {
		at("2026-11-01T03:30:00Z");
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const { html } = await get("/trends");
		expect(html).toContain("Spent so far in October");
		expect(html).not.toContain("November");
		// September has 30 days, so the 31st compares with all of it.
		expect(html).toContain("Oct 1–31 against Sep 1–30");
	});

	it("turns to November once it is November in Eastern, comparing with October's 1st", async () => {
		at("2026-11-01T05:30:00Z");
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		const { html } = await get("/trends");
		expect(html).toContain("Spent so far in November");
		expect(html).toContain("Nov 1 against Oct 1");
	});

	it("follows the stored time zone", async () => {
		try {
			at("2026-10-31T15:00:00Z");
			await resetDemo(env.DB, todayIn("Asia/Tokyo"));
			// The demo's reset puts the zone back to Eastern, so it's chosen after.
			await env.DB.prepare(
				"INSERT INTO household_settings (key, value) VALUES ('time_zone', 'Asia/Tokyo') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			).run();
			const { html } = await get("/trends");
			// 15:00 UTC on Oct 31 is already Nov 1 in Tokyo.
			expect(html).toContain("Spent so far in November");
		} finally {
			await env.DB.prepare(
				"DELETE FROM household_settings WHERE key = 'time_zone'",
			).run();
		}
	});

	it("never converts a transaction's own date: one dated the last day of last month stays in last month", async () => {
		at("2026-10-05T16:00:00Z");
		await resetDemo(env.DB, "2026-10-05");
		const before = (await get("/trends")).html;
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, category_id, category_source) VALUES (1, '2026-09-30', 99900, 'LATE SEP', 1, 'user')",
		).run();
		const after = (await get("/trends")).html;
		// Sep 30 is outside Sep 1–5 and not October, so the headline and sentence are unchanged.
		expect(text(after)).toContain(
			text(before).match(
				/\$[\d,]+ (less|more) than by this time in September\./,
			)?.[0] ?? "missing",
		);
		expect(after).toContain("Oct 1–5 against Sep 1–5");
	});
});

describe("early and empty states (P31)", () => {
	it("shows all spending by month and when Tally started, with one month of history", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const last = monthsBefore(today.slice(0, 7), 1);
		await env.DB.prepare("DELETE FROM transactions WHERE date < ?")
			.bind(`${last}-01`)
			.run();
		const { res, html } = await get("/trends");
		expect(res.status).toBe(200);
		expect(html).toContain("All spending");
		expect(html).toContain(
			`Trends fill in as months pass. Tally started in ${monthName(last)}.`,
		);
		// The first month of history may be only part of a month: striped, and said so in words.
		expect(html).toMatch(
			/<svg[^>]*role="img"[^>]*aria-label="All spending by month: \w+ \(from \w{3} \d+\) \$[\d,]+, \w+ so far \$[\d,]+\."/,
		);
		expect(html).toContain("<pattern");
		expect(html).toMatch(/fill="url\(#[a-z-]+-part\)"/);
		expect(html).not.toContain("Going well");
		expect(html).not.toContain("Spent so far in");
	});

	it("says there's nothing to show, with a way to Accounts, with no transactions", async () => {
		await env.DB.prepare("DELETE FROM transactions").run();
		const { res, html } = await get("/trends");
		expect(res.status).toBe(200);
		expect(html).toContain("No spending to show yet.");
		expect(html).toContain('href="/accounts"');
		expect(html).toMatch(/<h1[^>]*>Trends<\/h1>/);
	});
});

describe("outside the demo", () => {
	it("shows the household's numbers with no demo banner and never names Jev", async () => {
		const res = await trends.request("/trends", {}, notDemo);
		const html = await res.text();
		expect(res.status).toBe(200);
		expect(html).not.toContain("Demo data. Nothing here is real.");
		expect(html).toContain("Going well");
		expect(html).not.toMatch(/jev/i);
	});
});
