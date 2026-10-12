import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBillSuggestions } from "../src/bills/find";
import { matchBillPayments } from "../src/bills/match";
import { summarizeMonth } from "../src/budget";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { loadMonth } from "../src/db/month";
import { resetDemo } from "../src/demo/reset";
import { app } from "../src/index";
import { loadBillRows } from "../src/routes/bills";
import appCss from "../src/styles/app.css?raw";

/** app.css as rules: each selector (commas split, whitespace folded) with its declarations. */
const cssRules = [
	...appCss.replace(/\s+/g, " ").matchAll(/([^{}]+)\{([^{}]*)\}/g),
].flatMap(([, selectors = "", body = ""]) =>
	selectors.split(",").map((selector) => ({ selector: selector.trim(), body })),
);
const hidesWith = (selector: string) =>
	cssRules.some(
		(rule) => rule.selector === selector && /display:\s*none/.test(rule.body),
	);
const endsWithRule = (ending: string, display: RegExp) =>
	cssRules.some(
		(rule) => rule.selector.endsWith(ending) && display.test(rule.body),
	);

/** The Bills group under a status heading. Each group is one `<section`, so a check reads only that group's own total. */
const groupUnder = (html: string, heading: string) =>
	html.split("<section").find((part) => part.includes(`>${heading}</h2>`)) ??
	"";

/** The page's row for one occurrence: its `<li>` block, found by its label as a whole (not "Fri, Oct 2" in "Fri, Oct 23"). */
// A row is found by its label, which may carry the occurrence's amount after " · " (decision 101).
const occurrenceRow = (html: string, label: string) =>
	(
		html
			.split("<li")
			.find(
				(item) => item.includes(`>${label}<`) || item.includes(`>${label} · `),
			) ?? ""
	).split("</li>")[0] ?? "";

describe("Bills", () => {
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));
	afterEach(() => vi.useRealTimers());
	it.each(["2026-10-10T16:00:00Z", "2027-04-10T16:00:00Z"])(
		"shows grouped active bills and inactive disclosure on %s",
		async (instant) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(instant));
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			const today = todayIn(DEFAULT_TIME_ZONE);
			const month = today.slice(0, 7);
			const currentMonth = Number(today.slice(5, 7));
			await env.DB.prepare("DELETE FROM bills").run();
			const paidBy = await env.DB.prepare(
				"SELECT id, amount_cents FROM transactions WHERE amount_cents > 0 ORDER BY id LIMIT 1",
			).first<{ id: number; amount_cents: number }>();
			const priorPayments = await env.DB.prepare(
				"SELECT id FROM transactions WHERE amount_cents > 0 AND id != ? ORDER BY id LIMIT 2",
			)
				.bind(paidBy?.id ?? 0)
				.all<{ id: number }>();
			expect(paidBy).toBeDefined();
			expect(priorPayments.results).toHaveLength(2);
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name) VALUES(9301,'Overdue fixture',12345,3,'yearly',?,5,'OVERDUE FIXTURE')",
				).bind(currentMonth === 1 ? 12 : currentMonth - 1),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9302,'Due fixture',23456,?,'monthly',5,'DUE FIXTURE')",
				).bind(12),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name) VALUES(9303,'Upcoming this month',34567,18,'yearly',?,5,'UPCOMING FIXTURE')",
				).bind(currentMonth),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name) VALUES(9304,'Upcoming next March',99900,25,'yearly',?,5,'YEARLY FIXTURE')",
				).bind(3),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9305,'Paid fixture',? ,3,'monthly',5,'PAID FIXTURE')",
				).bind((paidBy?.amount_cents ?? 0) + 1234),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,active) VALUES(9306,'Inactive fixture',1000,25,'monthly',5,'INACTIVE FIXTURE',0)",
				),
			]);
			await env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9305,?,?,'user','linked')",
			)
				.bind(month, paidBy?.id ?? 0)
				.run();
			await env.DB.batch(
				[
					[9303, String(Number(today.slice(0, 4)) - 1)],
					[9304, today.slice(0, 4)],
				].map(([billId, period], index) =>
					env.DB.prepare(
						"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,? ,?,'user','linked')",
					).bind(billId, period, priorPayments.results[index]?.id ?? 0),
				),
			);
			const html = await (
				await exports.default.fetch("http://tally.test/bills")
			).text();
			expect(html).toContain("<title>Bills · Tally</title>");
			for (const heading of [
				"Overdue",
				"Due in the next 7 days",
				"Upcoming",
				"Paid this month",
				"Inactive (1)",
			])
				expect(html).toContain(heading);
			expect(html).toContain("bills to pay soon");
			expect(html).toMatch(
				/\$[\d,]+ a month in bills, \$[\d,]+ still to pay in [A-Z][a-z]+/,
			);
			for (const [status, total] of [
				["Overdue", "$123.45"],
				["Due in the next 7 days", "$234.56"],
				["Upcoming", "$345.67 this month"],
				["Paid this month", "$12.34"],
			] as const)
				expect(groupUnder(html, status)).toContain(
					`<span class="ml-auto shrink-0">${total}</span>`,
				);
		},
	);
	it.each([
		{
			instant: "2026-10-08T16:00:00Z",
			dueDay: 28,
			paidPeriod: null,
			groups: ["Overdue"],
		},
		{
			instant: "2026-10-08T16:00:00Z",
			dueDay: 28,
			paidPeriod: "2026-09",
			groups: ["Upcoming"],
		},
		{
			instant: "2026-10-05T16:00:00Z",
			dueDay: 20,
			paidPeriod: null,
			groups: ["Overdue"],
		},
		{
			instant: "2026-10-25T16:00:00Z",
			dueDay: 20,
			paidPeriod: null,
			groups: ["Overdue"],
		},
	])(
		"counts October's unpaid occurrence for due day $dueDay at $instant",
		async ({ instant, dueDay, paidPeriod, groups }) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(instant));
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await env.DB.prepare("DELETE FROM bills").run();
			await env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9399,'Monthly occurrence fixture',10000,?,'monthly',5,'MONTHLY OCCURRENCE FIXTURE')",
			)
				.bind(dueDay)
				.run();
			if (paidPeriod) {
				const transaction = await env.DB.prepare(
					"SELECT id FROM transactions WHERE amount_cents > 0 ORDER BY id LIMIT 1",
				).first<{ id: number }>();
				expect(transaction).toBeDefined();
				await env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9399,?,?,'user','linked')",
				)
					.bind(paidPeriod, transaction?.id ?? 0)
					.run();
			}
			const html = await (
				await exports.default.fetch("http://tally.test/bills")
			).text();
			expect(html).toContain("$100 still to pay in October");
			for (const status of [
				"Overdue",
				"Due in the next 7 days",
				"Upcoming",
				"Paid this month",
			])
				expect(html.includes(status)).toBe(groups.includes(status));
			for (const status of groups)
				expect(groupUnder(html, status)).toContain(
					'<span class="ml-auto shrink-0">$100.00',
				);
		},
	);
	it.each([true, false])(
		"keeps October headings equal to their rendered rows when the September occurrence is %s present",
		async (includeOverdueBill) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-08T16:00:00Z"));
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await env.DB.prepare("DELETE FROM bills").run();
			if (includeOverdueBill) {
				await env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9398,'Monthly occurrence fixture',10000,28,'monthly',5,'MONTHLY OCCURRENCE FIXTURE')",
				).run();
			}
			await env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9397,'Upcoming fixture',5000,20,'monthly',5,'UPCOMING FIXTURE')",
			).run();
			const transaction = await env.DB.prepare(
				"SELECT id FROM transactions WHERE amount_cents > 0 ORDER BY id LIMIT 1",
			).first<{ id: number }>();
			expect(transaction).toBeDefined();
			await env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9397,'2026-09',?,'user','linked')",
			)
				.bind(transaction?.id ?? 0)
				.run();

			const html = await (
				await exports.default.fetch("http://tally.test/bills")
			).text();
			const sections = [
				...html.matchAll(/<section class="mt-4">([\s\S]*?)<\/section>/g),
			];
			const groups = new Map<string, { total: number; rowTotal: number }>();
			for (const [, section] of sections) {
				// The group's total is the only ml-auto span in its section (rows never use it).
				const heading = section?.match(
					/<span class="ml-auto shrink-0">\$([\d,]+\.\d{2})/,
				);
				if (!heading || !section) continue;
				const title = section.match(
					/>(Overdue|Due in the next 7 days|Upcoming|Paid this month)<\/h2>/,
				)?.[1];
				if (!title) continue;
				const rows = [
					...section.matchAll(
						/<span class="shrink-0 text-lg">\$([\d,]+\.\d{2})<\/span>/g,
					),
				];
				const cents = (value: string) =>
					Math.round(Number(value.replaceAll(",", "")) * 100);
				const headingTotal = heading[1];
				if (!headingTotal) continue;
				groups.set(title, {
					total: cents(headingTotal),
					rowTotal: rows.reduce(
						(sum, row) => sum + (row[1] ? cents(row[1]) : 0),
						0,
					),
				});
			}
			expect(groups.size).toBe(includeOverdueBill ? 2 : 1);
			for (const group of groups.values())
				expect(group.total).toBe(group.rowTotal);
			if (includeOverdueBill) expect(groups.get("Overdue")?.total).toBe(10000);
			else expect(groups.has("Overdue")).toBe(false);
			expect(groups.get("Upcoming")?.total).toBe(5000);
			// October still to pay is October's $100 + $50 = $150; September's $100 is overdue but wasn't due this month.
			expect(html).toContain(
				includeOverdueBill
					? "$150 still to pay in October"
					: "$50 still to pay in October",
			);
		},
	);

	it("has a How this works link to the Bills section, under the status sentence (decision 84)", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		const link =
			/<a href="\/how-it-works#bills" aria-label="How this works: bills" class="[^"]*min-h-11[^"]*">How this works<\/a>/;
		expect(html).toMatch(link);
		// Only the page's own link: each status heading's Why? goes to the same section too (#341).
		expect(html.match(/aria-label="How this works: bills"/g)).toHaveLength(1);
		const at = (text: string | RegExp) =>
			typeof text === "string" ? html.indexOf(text) : html.search(text);
		expect(at("bills to pay soon")).toBeLessThan(at(link));
		expect(at(link)).toBeLessThan(at("Add a bill"));
		// The section it points to is on How Tally works.
		const how = await (
			await exports.default.fetch("http://tally.test/how-it-works")
		).text();
		expect(how).toMatch(/<section[^>]*id="bills"/);
	});

	it("keeps the How this works link when there are no bills", async () => {
		await env.DB.prepare("DELETE FROM bills").run();
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html).toContain('href="/how-it-works#bills"');
	});

	it("puts How this works under Possible bills' title, as on Bills", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/find")
		).text();
		const link =
			/<a href="\/how-it-works#bills" aria-label="How this works: bills" class="[^"]*min-h-11[^"]*">How this works<\/a>/;
		expect(html).toMatch(link);
		const at = (text: string | RegExp) =>
			typeof text === "string" ? html.indexOf(text) : html.search(text);
		expect(at("Possible bills</h1>")).toBeLessThan(at(link));
		expect(at(link)).toBeLessThan(at("About the same amount"));
	});

	// DESIGN.md Type roles: a page title is 5xl, so the title does not shrink on the Bills tab.
	it.each([
		["/bills", "Bills"],
		["/bills/find", "Possible bills"],
	])("draws %s's h1 as a 5xl page title", async (path, title) => {
		const html = await (
			await exports.default.fetch(`http://tally.test${path}`)
		).text();
		expect(html).toMatch(
			new RegExp(
				`<h1 class="font-serif text-5xl font-semibold tracking-tight">\\s*${title}\\s*</h1>`,
			),
		);
	});

	it("keeps the Add a bill sheet's title at the 4xl sheet role, a size below the page's", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		expect(html).toContain(
			'<h2 id="bill-sheet-title" class="font-serif text-4xl font-semibold tracking-tight"',
		);
		expect(html).toContain(
			'<h1 class="font-serif text-5xl font-semibold tracking-tight">Bills</h1>',
		);
	});

	it("lists quarterly months from the selected first month and defaults to January", async () => {
		const defaultHtml = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		expect(defaultHtml).toContain(
			"Then every 3 months: January, April, July and October.",
		);
		const post = (body: URLSearchParams) =>
			exports.default.fetch("http://tally.test/bills", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Origin: "http://tally.test",
				},
				body,
			});
		const html = await (
			await post(
				new URLSearchParams({
					name: "Quarterly fixture",
					amount: "bad",
					due_day: "12",
					frequency: "quarterly",
					anchor_month: "10",
					category_id: "1",
					merchant_raw_name: "QUARTERLY FIXTURE",
				}),
			)
		).text();
		const encoded = html.replaceAll("&#39;", "'").replaceAll("&amp;", "&");
		expect(encoded).toContain(
			"Then every 3 months: October, January, April and July.",
		);
	});

	it("offers all five frequencies and their cadence fields", async () => {
		const form = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		for (const words of [
			"Monthly",
			"Yearly",
			"Weekly",
			"Every two weeks",
			"Quarterly",
			"Day of the week",
			"A date it was paid",
			"Due day",
			"First month",
		])
			expect(form).toContain(words);

		const response = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Biweekly fixture",
				amount: "bad",
				due_day: "5",
				frequency: "biweekly",
				anchor_date: "2026-10-02",
				category_id: "1",
				merchant_raw_name: "BIWEEKLY FIXTURE",
			}),
		});
		expect(await response.text()).toContain(
			"Then every two weeks from that date. Next: Oct 16.",
		);
	});

	it("says the next every-two-weeks date after today, however old the anchor is", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
		try {
			const response = await exports.default.fetch("http://tally.test/bills", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Origin: "http://tally.test",
				},
				body: new URLSearchParams({
					name: "Biweekly fixture",
					amount: "bad",
					due_day: "5",
					frequency: "biweekly",
					anchor_date: "2026-09-04",
					category_id: "1",
					merchant_raw_name: "BIWEEKLY FIXTURE",
				}),
			});
			expect(await response.text()).toContain(
				"Then every two weeks from that date. Next: Oct 16.",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the yearly month only for yearly bills and the due day only where a bill has one", () => {
		expect(hidesWith(".bill-year-label")).toBe(true);
		expect(
			endsWithRule(
				'.bill-form:has(input[name="frequency"][value="yearly"]:checked) .bill-year-label',
				/display:\s*inline/,
			),
		).toBe(true);
		expect(
			endsWithRule(
				'.bill-form:has(input[name="frequency"][value="biweekly"]:checked) .bill-due-day',
				/display:\s*none/,
			),
		).toBe(true);
		expect(
			endsWithRule(
				'.bill-form:has(input[name="frequency"][value="weekly"]:checked) .bill-due-day',
				/display:\s*none/,
			),
		).toBe(true);
	});

	it("asks a biweekly bill only for its date, never for a due day", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Origin: "http://tally.test",
				},
				body: new URLSearchParams({
					name: "Undated fixture",
					amount: "10.00",
					due_day: "",
					frequency: "biweekly",
					anchor_date: "",
					category_id: "1",
					merchant_raw_name: "UNDATED FIXTURE",
				}),
			})
		).text();
		expect(html).toContain("Choose a date.");
		expect(html).not.toContain("Enter a day from 1 to 31.");
	});

	it("saves a biweekly bill's due day as the weekday of its anchor date", async () => {
		const response = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Every two weeks fixture",
				amount: "10.00",
				due_day: "",
				frequency: "biweekly",
				anchor_date: "2026-10-02",
				category_id: "1",
				merchant_raw_name: "EVERY TWO WEEKS FIXTURE",
			}),
		});
		expect(response.status).toBe(303);
		expect(
			await env.DB.prepare(
				"SELECT due_day, anchor_date FROM bills WHERE name='Every two weeks fixture'",
			).first(),
		).toEqual({ due_day: 5, anchor_date: "2026-10-02" });
	});

	it("adds a bill and returns htmx feedback", async () => {
		const body = new URLSearchParams({
			name: "Gym",
			amount: "42.50",
			due_day: "12",
			frequency: "monthly",
			category_id: "1",
			merchant_raw_name: "CITY GYM",
		});
		const res = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
				Origin: "http://tally.test",
			},
			body,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Trigger")).toContain("Bill added");
		expect(res.headers.get("HX-Push-Url")).toBe("/bills");
		expect(
			(
				await env.DB.prepare(
					"SELECT amount_cents FROM bills WHERE name = 'Gym'",
				).first<{ amount_cents: number }>()
			)?.amount_cents,
		).toBe(4250);
	});

	describe("the bank text a bill is typed with", () => {
		const saveBill = (path: string, fields: Record<string, string>) =>
			exports.default.fetch(`http://tally.test${path}`, {
				method: "POST",
				redirect: "manual",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Origin: "http://tally.test",
				},
				body: new URLSearchParams(fields),
			});
		const stored = (name: string) =>
			env.DB.prepare(
				"SELECT id, merchant_raw_name AS text, merchant_raw_text AS flag FROM bills WHERE name = ?",
			)
				.bind(name)
				.first<{ id: number; text: string; flag: number }>();

		it("saves the store the bank names, so the charge with that bank text links to the bill", async () => {
			// The demo's $16.43 CVS charge. Its own day is the bill's due day, so the charge is the one it links.
			const charge = await env.DB.prepare(
				"SELECT id, date FROM transactions WHERE raw_name = 'CHECKCARD 0921 CVS'",
			).first<{ id: number; date: string }>();
			const res = await saveBill("/bills", {
				name: "Pharmacy",
				amount: "16.43",
				due_day: String(Number(charge?.date.slice(8))),
				frequency: "monthly",
				category_id: "1",
				merchant_raw_name: "CHECKCARD 0921 CVS",
			});
			expect(res.status).toBe(303);
			const bill = await stored("Pharmacy");
			expect(bill).toMatchObject({ text: "CVS Pharmacy", flag: 0 });
			const linked = await env.DB.prepare(
				"SELECT transaction_id AS id FROM bill_payments WHERE bill_id = ? AND status = 'linked'",
			)
				.bind(bill?.id)
				.all();
			expect(linked.results).toEqual([{ id: charge?.id }]);
		});

		it("saves a bank text no transaction has as typed", async () => {
			const text = "SUNNY VALLEY PET 0412";
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM transactions WHERE raw_name = ?",
				)
					.bind(text)
					.first("n"),
			).toBe(0);
			const res = await saveBill("/bills", {
				name: "Vet",
				amount: "40",
				due_day: "5",
				frequency: "monthly",
				category_id: "1",
				merchant_raw_name: text,
			});
			expect(res.status).toBe(303);
			expect(await stored("Vet")).toMatchObject({ text, flag: 0 });
		});

		it("keeps a bill saved under the bank text before merchant keys while only its amount changes", async () => {
			await env.DB.prepare(
				"INSERT INTO bills (id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,merchant_raw_text) VALUES (9681,'Legacy pharmacy',1643,14,'monthly',1,'CHECKCARD 0921 CVS',1)",
			).run();
			const res = await saveBill("/bills/9681", {
				name: "Legacy pharmacy",
				amount: "17.00",
				due_day: "14",
				frequency: "monthly",
				category_id: "1",
				merchant_raw_name: "CHECKCARD 0921 CVS",
			});
			expect(res.status).toBe(303);
			expect(
				await env.DB.prepare(
					"SELECT amount_cents AS cents, merchant_raw_name AS text, merchant_raw_text AS flag FROM bills WHERE id = 9681",
				).first(),
			).toEqual({ cents: 1700, text: "CHECKCARD 0921 CVS", flag: 1 });
		});

		it("saves a bank text typed on an edit as its transaction's key", async () => {
			await env.DB.prepare(
				"INSERT INTO bills (id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,merchant_raw_text) VALUES (9682,'Changed pharmacy',1643,14,'monthly',1,'OLD PHARMACY TEXT',1)",
			).run();
			const res = await saveBill("/bills/9682", {
				name: "Changed pharmacy",
				amount: "16.43",
				due_day: "14",
				frequency: "monthly",
				category_id: "1",
				merchant_raw_name: "CHECKCARD 0921 CVS",
			});
			expect(res.status).toBe(303);
			expect(await stored("Changed pharmacy")).toMatchObject({
				text: "CVS Pharmacy",
				flag: 0,
			});
		});

		it("clears the legacy flag when a changed bank text's store is the text the bill already holds", async () => {
			// The demo's $16.43 CVS charge, on the day the bill is due, as the first test above uses.
			const charge = await env.DB.prepare(
				"SELECT id, date FROM transactions WHERE raw_name = 'CHECKCARD 0921 CVS'",
			).first<{ id: number; date: string }>();
			const dueDay = String(Number(charge?.date.slice(8)));
			await env.DB.prepare(
				"INSERT INTO bills (id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,merchant_raw_text) VALUES (9683,'Legacy CVS',1643,?,'monthly',1,'CVS Pharmacy',1)",
			)
				.bind(Number(dueDay))
				.run();
			const res = await saveBill("/bills/9683", {
				name: "Legacy CVS",
				amount: "16.43",
				due_day: dueDay,
				frequency: "monthly",
				category_id: "1",
				merchant_raw_name: "CHECKCARD 0921 CVS",
			});
			expect(res.status).toBe(303);
			expect(await stored("Legacy CVS")).toMatchObject({
				text: "CVS Pharmacy",
				flag: 0,
			});
			const linked = await env.DB.prepare(
				"SELECT transaction_id AS id FROM bill_payments WHERE bill_id = 9683 AND status = 'linked'",
			).all();
			expect(linked.results).toEqual([{ id: charge?.id }]);
		});
	});

	it("focuses the sheet heading and uses CSS to reveal the yearly month", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		expect(html).toMatch(/id="bill-sheet-title"[^>]*autofocus/);
		expect(html).toContain('class="bill-form');
		expect(html).toContain('class="bill-month');
	});

	it("leads the Inactive disclosure with a chevron that turns when it opens", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		const details = html.match(
			/<details[^>]*>\s*<summary[^>]*>[\s\S]*?<\/summary>/,
		);
		expect(details?.[0]).toMatch(/<details class="group /);
		expect(details?.[0]).toContain("group-open:rotate-90");
		expect(details?.[0]).toContain('data-icon="chevron-right"');
		expect(details?.[0]).toMatch(/Inactive \(1\)\s*<\/summary>/);
	});

	it("does not call an inactive-only bill list empty", async () => {
		await env.DB.prepare("UPDATE bills SET active=0").run();
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html).toContain("Inactive (8)");
		expect(html).not.toContain("No bills yet.");
		// With bills but none due, the count is accurate and stays.
		expect(html).toContain("0 bills to pay soon, $0.00 in all");
	});

	it("says No bills yet. once on a first visit, without a count of zero above it", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
		]);
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html).toContain("No bills yet.");
		expect(html).not.toContain("to pay soon");
	});

	it("validates category and yearly month with alerts", async () => {
		const res = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Tax",
				amount: "10",
				due_day: "1",
				frequency: "yearly",
				anchor_month: "13",
				category_id: "999",
				merchant_raw_name: "TAX",
			}),
		});
		const html = await res.text();
		expect(html.match(/role="alert"/g)?.length).toBe(2);
		expect(html).toContain("Choose a month.");
		expect(html).toContain("Choose an existing category.");
	});

	it("redirects a successful non-htmx save", async () => {
		const res = await exports.default.fetch("http://tally.test/bills", {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Gym",
				amount: "20",
				due_day: "2",
				frequency: "monthly",
				anchor_month: "1",
				category_id: "1",
				merchant_raw_name: "GYM",
			}),
		});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/bills");
	});

	it("edits, deactivates and reactivates with announcements", async () => {
		const edit = await exports.default.fetch("http://tally.test/bills/1", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"HX-Request": "true",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Movies",
				amount: "3.99",
				due_day: "4",
				frequency: "monthly",
				anchor_month: "1",
				category_id: "5",
				merchant_raw_name: "APPLE.COM/BILL",
			}),
		});
		expect(edit.headers.get("HX-Trigger")).toContain('"announce":"Bill saved"');
		expect(
			await env.DB.prepare("SELECT name FROM bills WHERE id=1").first("name"),
		).toBe("Movies");
		for (const [action, message] of [
			["deactivate", "Bill deactivated"],
			["reactivate", "Bill reactivated"],
		]) {
			const res = await exports.default.fetch(
				`http://tally.test/bills/1/${action}`,
				{
					method: "POST",
					headers: { "HX-Request": "true", Origin: "http://tally.test" },
				},
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				`"announce":"${message}"`,
			);
			expect(res.headers.get("HX-Trigger")).toContain("toast");
		}
	});

	it.each([
		"2026-01-01",
		"2026-06-15",
		"2028-02-29",
		"2026-02-24",
		"2026-03-02",
		"2026-10-26",
		"2026-10-31",
		"2026-12-09",
		"2026-12-31",
	])("keeps every demo status available on %s", async (date) => {
		await resetDemo(env.DB, date);
		const { rows } = await loadBillRows(env.DB, date);
		expect(
			(await loadBillSuggestions(env.DB, date)).map((row) => row.displayName),
		).toEqual(["City Gym", "Procreate Dreams", "YouTube Premium"]);
		expect(
			new Set(rows.filter((row) => row.active).map((row) => row.status)),
		).toEqual(new Set(["overdue", "due", "upcoming", "paid"]));
		const late = rows.find((row) => row.name === "Water");
		expect(late).toBeTruthy();
		const waterPayment = await env.DB.prepare(
			`SELECT t.date, CASE WHEN length(bp.period)=4 THEN bp.period || '-' || printf('%02d', b.anchor_month) ELSE bp.period END || '-' || printf('%02d', b.due_day) AS due
			 FROM bill_payments bp JOIN bills b ON b.id=bp.bill_id JOIN transactions t ON t.id=bp.transaction_id
			 WHERE b.name='Water' AND bp.status='linked' ORDER BY bp.period DESC LIMIT 1`,
		).first<{ date: string; due: string }>();
		expect(waterPayment).toBeTruthy();
		expect(
			Math.floor(Date.parse(`${waterPayment?.date}T00:00:00Z`) / 86400000) -
				Math.floor(Date.parse(`${waterPayment?.due}T00:00:00Z`) / 86400000),
		).toBe(3);
		const future = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM transactions WHERE date > ?",
		)
			.bind(date)
			.first<{ n: number }>();
		expect(future?.n).toBe(0);
		const onTime = rows.find((row) => row.name === "Streaming");
		expect(onTime?.status).toBe("paid");
		expect(onTime?.paidDate).toBe(onTime?.dueDate);
		const lookalike = await env.DB.prepare(
			`SELECT t.id, t.date, t.amount_cents, bp.status
			 FROM transactions t
			 JOIN bills b ON b.name='Streaming' AND b.merchant_raw_name=t.raw_name
			 LEFT JOIN bill_payments bp ON bp.transaction_id=t.id
			 WHERE t.amount_cents BETWEEN b.amount_cents * 0.9 AND b.amount_cents * 1.1
			   AND t.date <> ?
			 ORDER BY t.date DESC LIMIT 1`,
		)
			.bind(onTime?.paidDate)
			.first<{
				id: number;
				date: string;
				amount_cents: number;
				status: string | null;
			}>();
		expect(lookalike).toBeTruthy();
		expect(Boolean(lookalike?.date && lookalike.date <= date)).toBe(true);
		expect(lookalike?.status).toBeNull();
		// The demo's set-aside stays small enough that Safe to spend stays positive.
		const setAside = rows
			.filter((row) => row.active && ["due", "overdue"].includes(row.status))
			.reduce((sum, row) => sum + row.amountCents, 0);
		expect(setAside).toBeLessThan(50_000);
	});

	it("shows the demo's weekly Daycare total for its five October Fridays", async () => {
		await resetDemo(env.DB, "2026-10-31");
		const bill = await env.DB.prepare(
			"SELECT id,amount_cents,frequency FROM bills WHERE name='Daycare'",
		).first<{ id: number; amount_cents: number; frequency: string }>();
		expect(bill).toEqual({ id: 8, amount_cents: 24000, frequency: "weekly" });
		const { rows } = await loadBillRows(env.DB, "2026-10-31");
		const daycare = rows.find((row) => row.name === "Daycare");
		// Every October Friday is paid by now, so the next one (November's first) is shown too; October's are the total.
		const october = (daycare?.totalOccurrences ?? []).filter((occurrence) =>
			occurrence.dueDate.startsWith("2026-10"),
		);
		expect(october.map((occurrence) => occurrence.dueDate).sort()).toEqual([
			"2026-10-02",
			"2026-10-09",
			"2026-10-16",
			"2026-10-23",
			"2026-10-30",
		]);
		expect(
			october.reduce((sum, occurrence) => sum + occurrence.amountCents, 0),
		).toBe(120000);
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html).toContain("Daycare");
		expect(
			october.reduce((sum, occurrence) => sum + occurrence.amountCents, 0),
		).toBe(120000);
	});

	it("pays the demo's past Daycare Fridays from its own Childcare budget", async () => {
		await resetDemo(env.DB, "2026-10-10");
		const category = await env.DB.prepare(
			"SELECT c.name AS name, b.amount_cents AS budget FROM bills d JOIN categories c ON c.id = d.category_id JOIN budget_amounts b ON b.category_id = c.id WHERE d.name = 'Daycare'",
		).first<{ name: string; budget: number }>();
		expect(category).toEqual({ name: "Childcare", budget: 104000 });
		const { rows } = await loadBillRows(env.DB, "2026-10-10");
		const daycare = rows.find((row) => row.name === "Daycare");
		expect(
			Object.fromEntries(
				(daycare?.totalOccurrences ?? []).map((occurrence) => [
					occurrence.dueDate,
					occurrence.status,
				]),
			),
		).toEqual({
			"2026-10-02": "paid",
			"2026-10-09": "paid",
			"2026-10-16": "due",
			"2026-10-23": "upcoming",
			"2026-10-30": "upcoming",
		});
	});

	it("keeps the demo's Safe to spend positive on a fixed day, with Eating Out the one category over", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
		try {
			await resetDemo(env.DB, "2026-10-10");
			const html = await (
				await exports.default.fetch("http://tally.test/")
			).text();
			const headline =
				html.match(/class="font-serif text-6xl[^"]*">([^<]*)</)?.[1] ?? "";
			expect(headline).toMatch(/^\$\d/);
			expect(html).toContain(
				"Eating Out is $36 over. Everything else is on track.",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts a weekly bill once in the Bills summary, with each unpaid due occurrence in its amount", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
		await resetDemo(env.DB, "2026-10-07");
		await env.DB.prepare("DELETE FROM bills").run();
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9396,'Weekly fixture',10000,5,'weekly',5,'WEEKLY FIXTURE')",
		).run();
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html.match(/\d+ bills? to pay soon, \$[\d.]+ in all/)?.[0]).toBe(
			"1 bill to pay soon, $200.00 in all",
		);
		const home = await (
			await exports.default.fetch("http://tally.test/")
		).text();
		expect(home).toContain("Weekly fixture");
		expect(home).toContain("Bills due soon");
	});

	it("reads one weekly bill with two unpaid due occurrences as one bill and both amounts", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-07T16:00:00Z"));
		await resetDemo(env.DB, "2026-10-07");
		await env.DB.prepare("DELETE FROM bills").run();
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9395,'Weekly fixture',24000,5,'weekly',5,'WEEKLY FIXTURE')",
		).run();
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		expect(html.match(/\d+ bills? to pay soon, \$[\d,.]+ in all/)?.[0]).toBe(
			"1 bill to pay soon, $480.00 in all",
		);
	});

	it("counts the next Friday in November when it falls due before the month ends", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-30T16:00:00Z"));
		await resetDemo(env.DB, "2026-10-30");
		await env.DB.prepare("DELETE FROM bills").run();
		await env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9397,'Friday fixture',24000,5,'weekly',5,'FRIDAY FIXTURE')",
		).run();
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		// October's five Fridays are unpaid (the 2nd to the 23rd overdue, the 30th due), and Nov 6 is due in a week.
		expect(html.match(/\d+ bills? to pay soon, \$[\d,.]+ in all/)?.[0]).toBe(
			"1 bill to pay soon, $1,440.00 in all",
		);
	});

	it("lists on Home a monthly bill whose next due date is in November, once October is paid", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-30T16:00:00Z"));
		await resetDemo(env.DB, "2026-10-30");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9398,'Rent fixture',120000,6,'monthly',5,'RENT FIXTURE')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 9398,'2026-10',id,'user','linked' FROM transactions LIMIT 1",
			),
		]);
		const home = await (
			await exports.default.fetch("http://tally.test/")
		).text();
		expect(home).toContain("Bills due soon");
		expect(home).toContain("Rent fixture");
	});

	it("totals a weekly bill's every Friday this month in its group headings", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-11T16:00:00Z"));
		await resetDemo(env.DB, "2026-10-11");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9631,'Friday totals fixture',24000,5,'weekly',5,'FRIDAY TOTALS FIXTURE')",
			),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9632,'Month totals fixture',10000,28,'monthly',5,'MONTH TOTALS FIXTURE')",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9641,1,'2026-10-02',24000,'Friday Totals Oct Two'),(9642,1,'2026-10-09',24000,'Friday Totals Oct Nine'),(9643,1,'2026-09-28',10000,'Month Totals Sep')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9631,'2026-10-02',9641,'user','linked'),(9631,'2026-10-09',9642,'user','linked'),(9632,'2026-09',9643,'user','linked')",
			),
		]);
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		// Due is the shown Oct 16 Friday. Upcoming is Oct 23 and Oct 30 plus the monthly bill's Oct 28.
		expect(groupUnder(html, "Due in the next 7 days")).toContain(
			'<span class="ml-auto shrink-0">$240.00</span>',
		);
		expect(groupUnder(html, "Upcoming")).toContain(
			'<span class="ml-auto shrink-0">$580.00 this month</span>',
		);
		expect(html).toContain("$820 still to pay in October");
	});

	it("refuses to save, deactivate or reactivate a missing bill", async () => {
		const post = (path: string, body = "") =>
			exports.default.fetch(`http://tally.test${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"HX-Request": "true",
					Origin: "http://tally.test",
				},
				body,
			});
		const body = new URLSearchParams({
			name: "Gym",
			amount: "42.50",
			due_day: "12",
			frequency: "monthly",
			category_id: "1",
			merchant_raw_name: "CITY GYM",
		}).toString();
		expect((await post("/bills/999999", body)).status).toBe(404);
		expect((await post("/bills/999999/deactivate")).status).toBe(404);
		expect((await post("/bills/999999/reactivate")).status).toBe(404);
	});

	it("gives the bill sheet a Cancel link and clears the URL after deactivating", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/new")
		).text();
		expect(html).toMatch(/<a[^>]*href="\/bills"[^>]*>\s*Cancel/);
		const { id } = (await env.DB.prepare(
			"SELECT id FROM bills WHERE active=1 LIMIT 1",
		).first<{ id: number }>()) as { id: number };
		const res = await exports.default.fetch(
			`http://tally.test/bills/${id}/deactivate`,
			{
				method: "POST",
				headers: { "HX-Request": "true", Origin: "http://tally.test" },
			},
		);
		expect(res.headers.get("HX-Push-Url")).toBe("/bills");
	});

	// A payment Plaid or Jev excluded can still pay a bill. Once linked it counts in Spent whatever its
	// exclusion, and linking or unlinking never writes the exclusion (spec §6.1 rule 4, §8.5).
	describe("a payment Plaid or Jev excluded that pays a bill", () => {
		const MONTH = "2026-07";
		type Machine = "plaid" | "jev";
		const BILL =
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9300,'Mortgage',150000,5,'monthly',5,'LANDLORD LLC')";
		/** A 1500.00 payment: a loan payment for Plaid, a transfer Jev flagged for Jev. */
		const setUp = async (source: Machine) => {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments"),
				env.DB.prepare(BILL),
				env.DB.prepare(
					`INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source,plaid_category,flag_transfer)
					 SELECT 9301,id,'${MONTH}-04',150000,'LANDLORD LLC',1,?1,
						CASE WHEN ?1 = 'plaid' THEN 'LOAN_PAYMENTS' END, CASE WHEN ?1 = 'jev' THEN 1 ELSE 0 END FROM accounts LIMIT 1`,
				).bind(source),
			]);
		};
		/** A split bank transaction of 2000.00 whose 1500.00 part is the bill's payment, excluded whole. */
		const setUpSplit = async (source: Machine) => {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments"),
				env.DB.prepare(BILL),
				env.DB.prepare(
					`INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source,is_split,plaid_category,flag_transfer)
					 SELECT 9310,id,'${MONTH}-04',200000,'LANDLORD LLC',1,?1,1,
						CASE WHEN ?1 = 'plaid' THEN 'TRANSFER_OUT' END, CASE WHEN ?1 = 'jev' THEN 1 ELSE 0 END FROM accounts LIMIT 1`,
				).bind(source),
				env.DB.prepare(
					`INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source,parent_id)
					 SELECT 9311,id,'${MONTH}-04',150000,'LANDLORD LLC',1,?,9310 FROM accounts LIMIT 1`,
				).bind(source),
				env.DB.prepare(
					`INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,excluded,excluded_source,parent_id)
					 SELECT 9312,id,'${MONTH}-04',50000,'ELSEWHERE',1,?,9310 FROM accounts LIMIT 1`,
				).bind(source),
			]);
		};
		const state = async (...ids: number[]) =>
			(
				await env.DB.prepare(
					`SELECT id, excluded, excluded_source FROM transactions WHERE id IN (${ids.join(",")}) ORDER BY id`,
				).all()
			).results;
		const spent = async () =>
			summarizeMonth({
				month: MONTH,
				...(await loadMonth(env.DB, MONTH)),
				unpaidDueBillsCents: 0,
			}).totalSpentCents;
		const post = (path: string, body?: Record<string, string>) =>
			exports.default.fetch(`http://tally.test${path}`, {
				method: "POST",
				redirect: "manual",
				headers: {
					Origin: "http://tally.test",
					"HX-Request": "true",
					...(body
						? { "content-type": "application/x-www-form-urlencoded" }
						: {}),
				},
				...(body ? { body: new URLSearchParams(body) } : {}),
			});
		const link = (transaction: number) =>
			post("/bills/9300/link", {
				transaction_id: String(transaction),
				period: MONTH,
				opened_period: MONTH,
			});
		const unlink = () => post(`/bills/9300/occurrences/${MONTH}/unlink`);
		const linkedBy = async () =>
			(
				await env.DB.prepare(
					"SELECT matched_by FROM bill_payments WHERE bill_id=9300 AND status='linked'",
				).first<{ matched_by: string }>()
			)?.matched_by;

		it.each(["plaid", "jev"] as const)(
			"counts a %s-excluded payment while the matcher's link stands, and not after Not this one, leaving its exclusion as it was",
			async (source) => {
				await setUp(source);
				const base = await spent();
				const exclusion = [{ id: 9301, excluded: 1, excluded_source: source }];
				expect(await state(9301)).toEqual(exclusion);

				await matchBillPayments(env.DB, "2026-07-12");
				expect(await linkedBy()).toBe("auto");
				// It counts because it pays the bill; nothing was written to its exclusion.
				expect(await state(9301)).toEqual(exclusion);
				expect(await spent()).toBe(base + 150000);

				await unlink();
				expect(await state(9301)).toEqual(exclusion);
				expect(await spent()).toBe(base);
			},
		);

		it.each(["plaid", "jev"] as const)(
			"counts only the part that pays the bill when the matcher links one part of a %s-excluded split, and leaves the split as it was",
			async (source) => {
				await setUpSplit(source);
				const base = await spent();
				const whole = [9310, 9311, 9312].map((id) => ({
					id,
					excluded: 1,
					excluded_source: source,
				}));

				await matchBillPayments(env.DB, "2026-07-12");
				expect(await linkedBy()).toBe("auto");
				expect(await state(9310, 9311, 9312)).toEqual(whole);
				// The 1500.00 part counts; its 500.00 sibling and the split's parent don't.
				expect(await spent()).toBe(base + 150000);

				await unlink();
				expect(await state(9310, 9311, 9312)).toEqual(whole);
				expect(await spent()).toBe(base);
			},
		);

		it.each(["plaid", "jev"] as const)(
			"counts a person's hand link of a %s-excluded payment while it stands, and writes nothing to its exclusion",
			async (source) => {
				await setUp(source);
				const base = await spent();
				const exclusion = [{ id: 9301, excluded: 1, excluded_source: source }];

				await link(9301);
				expect(await linkedBy()).toBe("user");
				expect(await state(9301)).toEqual(exclusion);
				expect(await spent()).toBe(base + 150000);

				await unlink();
				expect(await state(9301)).toEqual(exclusion);
				expect(await spent()).toBe(base);
			},
		);

		it("leaves a payment a person excluded to the matcher, counts it once they link it by hand, and keeps it excluded after", async () => {
			await setUp("plaid");
			await env.DB.prepare(
				"UPDATE transactions SET excluded_source='user' WHERE id=9301",
			).run();
			const base = await spent();
			const exclusion = [{ id: 9301, excluded: 1, excluded_source: "user" }];
			await matchBillPayments(env.DB, "2026-07-12");
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=9300 AND status='linked'",
				).first("n"),
			).toBe(0);
			expect(await spent()).toBe(base);

			await link(9301);
			expect(await linkedBy()).toBe("user");
			// A person's hand link counts it because it's linked; their exclusion is as they left it.
			expect(await state(9301)).toEqual(exclusion);
			expect(await spent()).toBe(base + 150000);

			await unlink();
			expect(await state(9301)).toEqual(exclusion);
			expect(await spent()).toBe(base);
		});
	});

	it("shows a bill page and lets a person unlink and hand-link a chosen month", async () => {
		let html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain("Payments");
		expect(html).toContain("Not this one");
		const linked = await env.DB.prepare(
			"SELECT period FROM bill_payments WHERE bill_id=1 AND status='linked'",
		).first<{ period: string }>();
		const unlink = await exports.default.fetch(
			`http://tally.test/bills/1/occurrences/${linked?.period}/unlink`,
			{
				method: "POST",
				redirect: "manual",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		expect(unlink.headers.get("HX-Trigger")).toContain("Payment unlinked");
		expect(
			await env.DB.prepare(
				"SELECT status FROM bill_payments WHERE bill_id=1 AND period=?",
			)
				.bind(linked?.period)
				.first("status"),
		).toBe("dismissed");
		html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${linked?.period}/link`,
			)
		).text();
		expect(html).toContain("A late payment counts in its bill&#39;s month");
		expect(html).toContain("same merchant first, then closest amount");
	});

	it("always shows the current overdue yearly occurrence outside the history window", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare(
				"UPDATE bills SET frequency='yearly',anchor_month=12,due_day=1 WHERE id=1",
			),
		]);
		const html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain("2025");
		expect(html).toContain("Overdue");
	});

	it("keeps a bill's schedule while it has linked payments, and clears old dismissals otherwise", async () => {
		const change = () =>
			exports.default.fetch("http://tally.test/bills/1", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Origin: "http://tally.test",
				},
				body: new URLSearchParams({
					name: "Movies",
					amount: "3.99",
					due_day: "4",
					frequency: "yearly",
					anchor_month: "1",
					category_id: "5",
					merchant_raw_name: "NO AUTOMATIC REMATCH",
				}),
			});
		const count = async () =>
			(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=1",
				).first<{ n: number }>()
			)?.n;
		const before = await count();
		expect(before).toBeGreaterThan(0);
		const refused = await change();
		expect(refused.status).toBe(200);
		expect(await refused.text()).toContain("This bill has payments linked");
		expect(await count()).toBe(before);
		expect(
			(
				await env.DB.prepare("SELECT frequency FROM bills WHERE id=1").first<{
					frequency: string;
				}>()
			)?.frequency,
		).toBe("monthly");

		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 1,'2026-01',id,'user','dismissed' FROM transactions LIMIT 1",
			),
		]);
		expect((await change()).status).toBe(200);
		expect(await count()).toBe(0);
	});

	it("also refuses to change a linked yearly bill's month", async () => {
		await env.DB.prepare(
			"UPDATE bills SET frequency='yearly',anchor_month=3 WHERE id=1",
		).run();
		const res = await exports.default.fetch("http://tally.test/bills/1", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Streaming",
				amount: "2.99",
				due_day: "4",
				frequency: "yearly",
				anchor_month: "4",
				category_id: "5",
				merchant_raw_name: "APPLE.COM/BILL",
			}),
		});
		expect(await res.text()).toContain(
			"To change when it&#39;s due, deactivate it and add a new bill.",
		);
		expect(
			await env.DB.prepare("SELECT anchor_month FROM bills WHERE id=1").first(
				"anchor_month",
			),
		).toBe(3);
	});

	it("refuses to move a weekly bill with linked payments to another day of the week", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"UPDATE bills SET frequency='weekly',due_day=5,anchor_month=NULL,anchor_date=NULL WHERE id=1",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 1,'2026-10-09',id,'user','linked' FROM transactions WHERE id NOT IN (SELECT transaction_id FROM bill_payments WHERE status='linked') LIMIT 1",
			),
		]);
		const res = await exports.default.fetch("http://tally.test/bills/1", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				name: "Streaming",
				amount: "2.99",
				weekly_day: "1",
				frequency: "weekly",
				category_id: "5",
				merchant_raw_name: "APPLE.COM/BILL",
			}),
		});
		expect(await res.text()).toContain(
			"To change when it&#39;s due, deactivate it and add a new bill.",
		);
		expect(
			await env.DB.prepare("SELECT due_day FROM bills WHERE id=1").first(
				"due_day",
			),
		).toBe(5);
	});

	it("keeps an unpaid recent month before a newer linked month", async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 1,?,id,'user','linked' FROM transactions LIMIT 1",
			).bind(todayIn(DEFAULT_TIME_ZONE).slice(0, 7)),
		]);
		const earlier = new Date(
			`${todayIn(DEFAULT_TIME_ZONE).slice(0, 7)}-01T00:00:00Z`,
		);
		earlier.setUTCMonth(earlier.getUTCMonth() - 5);
		const period = earlier.toISOString().slice(0, 7);
		const html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain(`occurrences/${period}/link`);
		expect(html).toContain("Not paid");
	});

	describe("a linked payment older than six months", () => {
		beforeEach(async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-11T16:00:00Z"));
			await resetDemo(env.DB, "2026-10-11");
			await env.DB.prepare("DELETE FROM bills").run();
		});

		it("shows a monthly payment linked eight months back on its row, and opens its picker", async () => {
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9611,'Old month fixture',12345,3,'monthly',5,'OLD MONTH FIXTURE')",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9621,1,'2026-02-03',12345,'Feb Monthly Payment')",
				),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9611,'2026-02',9621,'user','linked')",
				),
			]);
			const html = await (
				await exports.default.fetch("http://tally.test/bills/9611")
			).text();
			expect(occurrenceRow(html, "February")).toContain("Feb Monthly Payment");
			expect(occurrenceRow(html, "February")).toContain("$123.45");
			const picker = await exports.default.fetch(
				"http://tally.test/bills/9611/occurrences/2026-02/link",
			);
			expect(picker.status).toBe(200);
		});

		it("lists a weekly payment linked to an early-February Friday on its row", async () => {
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9612,'Old Friday fixture',24000,5,'weekly',5,'OLD FRIDAY FIXTURE')",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9622,1,'2026-02-06',24000,'Feb Friday Payment')",
				),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9612,'2026-02-06',9622,'user','linked')",
				),
			]);
			const html = await (
				await exports.default.fetch("http://tally.test/bills/9612")
			).text();
			expect(occurrenceRow(html, "Fri, Feb 6")).toContain("Feb Friday Payment");
			expect(occurrenceRow(html, "Fri, Feb 6")).toContain("$240.00");
		});
	});

	describe("a weekly bill's missed occurrences on its page", () => {
		/** A Friday bill with no payments, as the page sees it on `today` (a household date). */
		async function fridayPage(today: string) {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date(`${today}T16:00:00Z`));
			await resetDemo(env.DB, today);
			await env.DB.prepare("DELETE FROM bills").run();
			await env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9501,'Friday fixture',24000,5,'weekly',5,'FRIDAY FIXTURE')",
			).run();
			return (
				await exports.default.fetch("http://tally.test/bills/9501")
			).text();
		}

		it("says Not paid for an unpaid Friday from an earlier month, and Bills shows the next one", async () => {
			const html = await fridayPage("2026-11-02");
			expect(occurrenceRow(html, "Fri, Oct 30")).toContain("Not paid");
			expect(occurrenceRow(html, "Fri, Nov 6")).toContain("Due");
			const bills = await (
				await exports.default.fetch("http://tally.test/bills")
			).text();
			expect(bills).toContain("Due Nov 6 · every Friday");
		});

		it("keeps each unpaid Friday this month overdue, and says Not paid only from an earlier month", async () => {
			const html = await fridayPage("2026-10-16");
			expect(occurrenceRow(html, "Fri, Oct 2")).toContain("Overdue");
			expect(occurrenceRow(html, "Fri, Oct 9")).toContain("Overdue");
			expect(occurrenceRow(html, "Fri, Oct 16")).toContain("Due");
			expect(occurrenceRow(html, "Fri, Sep 25")).toContain("Not paid");
		});
	});

	it("explains a linked payment's month the way the totals count it: a late payment in its bill's month, an early one in its bank month", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T12:00:00-04:00"));
		await resetDemo(env.DB, "2026-10-10");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"UPDATE bills SET frequency='monthly',due_day=10,anchor_month=NULL,anchor_date=NULL WHERE id=1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9921,1,'2026-10-02',1000,'LATE PAYER'),(9922,1,'2026-10-20',1000,'EARLY PAYER')",
			),
		]);
		const explain = async (period: string, transactionId: number) =>
			(
				await exports.default.fetch(
					`http://tally.test/bills/1/month-explanation?period=${period}&transaction_id=${transactionId}`,
				)
			).text();
		// September's bill, paid on October 2: it counts in September, not the bank's October.
		expect(await explain("2026-09", 9921)).toContain(
			"It counts in September&#39;s spending, not October&#39;s.",
		);
		// November's bill, paid on October 20: an early payment stays in the month the bank dated it.
		expect(await explain("2026-11", 9922)).toContain(
			"It counts in October&#39;s spending, its bank month.",
		);
	});

	it("lists and accepts only payments within three days of a weekly occurrence", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T12:00:00-04:00"));
		await resetDemo(env.DB, "2026-10-10");
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			env.DB.prepare(
				"UPDATE bills SET frequency='weekly',due_day=5,anchor_month=NULL,anchor_date=NULL WHERE id=1",
			),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9901,1,'2026-10-06',1000,'PICKER NEAR'),(9902,1,'2026-10-05',1000,'PICKER FAR')",
			),
		]);
		const html = await (
			await exports.default.fetch(
				"http://tally.test/bills/1/occurrences/2026-10-09/link",
			)
		).text();
		expect(html).toContain('value="9901"');
		expect(html).not.toContain('value="9902"');

		const res = await exports.default.fetch("http://tally.test/bills/1/link", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				transaction_id: "9902",
				period: "2026-10-09",
				opened_period: "2026-10-09",
			}),
		});
		expect(await res.text()).toContain("isn&#39;t within 3 days of");
		expect(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE transaction_id=9902",
			).first("n"),
		).toBe(0);
	});

	// Only money out pays a bill (Plaid's sign: positive is money out, #324). A same-merchant credit, a refund, is
	// neither offered in the picker nor linked by a POST that names it.
	describe("a credit is not a payment", () => {
		const period = "2026-10";
		const link = (transaction: number, due: string) =>
			exports.default.fetch("http://tally.test/bills/1/link", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Origin: "http://tally.test",
				},
				body: new URLSearchParams({
					transaction_id: String(transaction),
					period: due,
					opened_period: due,
				}),
			});
		const pickerHtml = async (due: string) =>
			(
				await exports.default.fetch(
					`http://tally.test/bills/1/occurrences/${due}/link`,
				)
			).text();
		const billStatus = async () =>
			(await loadBillRows(env.DB, "2026-10-10")).rows.find(
				(row) => row.id === 1,
			)?.status;
		const paidOccurrences = async (due: string) =>
			env.DB.prepare(
				"SELECT COUNT(*) AS n FROM bill_payments WHERE bill_id=1 AND period=? AND status='linked'",
			)
				.bind(due)
				.first("n");
		const safeToSpend = async () =>
			(await (await exports.default.fetch("http://tally.test/")).text()).match(
				/class="font-serif text-6xl[^"]*">([^<]*)</,
			)?.[1];

		beforeEach(async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
			await resetDemo(env.DB, "2026-10-10");
		});

		it("does not list a same-merchant credit for a monthly bill, and refuses to link it", async () => {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
				env.DB.prepare(
					"UPDATE bills SET frequency='monthly',due_day=15,anchor_month=NULL,anchor_date=NULL,amount_cents=1500,merchant_raw_name='REFUND CO',merchant_raw_text=0 WHERE id=1",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9950,1,'2026-10-12',2500,'REFUND CO'),(9951,1,'2026-10-12',-1500,'REFUND CO')",
				),
			]);
			const html = await pickerHtml(period);
			expect(html).toContain('name="transaction_id" value="9950"');
			expect(html).not.toContain('name="transaction_id" value="9951"');

			const before = {
				status: await billStatus(),
				safe: await safeToSpend(),
			};
			expect(before.status).toBe("due");
			const res = await link(9951, period);
			expect(await res.text()).toMatch(
				/<p role="alert"[^>]*>That payment isn&#39;t within 30 days of/,
			);
			expect(await paidOccurrences(period)).toBe(0);
			expect(await billStatus()).toBe(before.status);
			expect(await safeToSpend()).toBe(before.safe);
		});

		it("does not list a same-merchant credit inside a weekly bill's three days, and refuses to link it", async () => {
			const friday = "2026-10-16";
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
				env.DB.prepare(
					"UPDATE bills SET frequency='weekly',due_day=5,anchor_month=NULL,anchor_date=NULL,amount_cents=1500,merchant_raw_name='REFUND CO',merchant_raw_text=0 WHERE id=1",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9952,1,'2026-10-14',2500,'REFUND CO'),(9953,1,'2026-10-14',-1500,'REFUND CO')",
				),
			]);
			const html = await pickerHtml(friday);
			expect(html).toContain('name="transaction_id" value="9952"');
			expect(html).not.toContain('name="transaction_id" value="9953"');

			const before = {
				status: await billStatus(),
				safe: await safeToSpend(),
			};
			expect(before.status).not.toBe("paid");
			const res = await link(9953, friday);
			expect(await res.text()).toMatch(
				/<p role="alert"[^>]*>That payment isn&#39;t within 3 days of/,
			);
			expect(await paidOccurrences(friday)).toBe(0);
			expect(await billStatus()).toBe(before.status);
			expect(await safeToSpend()).toBe(before.safe);
		});

		it("still links a same-merchant payment out to the bill", async () => {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
				env.DB.prepare(
					"UPDATE bills SET frequency='monthly',due_day=15,anchor_month=NULL,anchor_date=NULL,amount_cents=1500,merchant_raw_name='REFUND CO',merchant_raw_text=0 WHERE id=1",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9950,1,'2026-10-12',2500,'REFUND CO'),(9951,1,'2026-10-12',-1500,'REFUND CO')",
				),
			]);
			await link(9950, period);
			expect(await paidOccurrences(period)).toBe(1);
			expect(await billStatus()).toBe("paid");
		});
	});

	// Choosing a month swaps the picker into the page (#323): the response must be the picker alone, not a second
	// copy of the page (a second <main>, #announcer, skip link and sidebar) nested in it.
	describe("choosing a month in Link a payment", () => {
		const period = "2026-10";
		const pickerFor = (headers: Record<string, string> = {}, chosen = period) =>
			exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${chosen}/link`,
				{ headers },
			);
		// What the vendored htmx 4 sends when a month chip (inside section#payment-picker) asks for its picker.
		const monthChipRequest = {
			"HX-Request": "true",
			"HX-Target": "section#payment-picker",
		};
		const pickerSection = (html: string) =>
			html.match(/<section id="payment-picker"[\s\S]*?<\/section>/)?.[0] ?? "";

		beforeEach(async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
			await resetDemo(env.DB, "2026-10-10");
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
				env.DB.prepare(
					"UPDATE bills SET frequency='monthly',due_day=15,anchor_month=NULL,anchor_date=NULL,amount_cents=1500,merchant_raw_name='STREAM CO',merchant_raw_text=0 WHERE id=1",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9960,1,'2026-10-12',1500,'STREAM CO'),(9961,1,'2026-10-13',1400,'STREAM CO')",
				),
			]);
		});
		afterEach(() => vi.useRealTimers());

		it("answers a month chip with only the picker, for htmx 4's real HX-Target header", async () => {
			const res = await pickerFor(monthChipRequest);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html.trimStart().startsWith('<section id="payment-picker"')).toBe(
				true,
			);
			expect(html).not.toContain("<html");
			expect(html).not.toContain("<main");
			expect(html).not.toContain('id="announcer"');
			expect(html).not.toContain('id="toasts"');
			expect(html.match(/id="payment-picker"/g)).toHaveLength(1);
		});

		it("leaves one main, one announcer and one picker once the swap puts the picker into the page", async () => {
			const page = await (await pickerFor()).text();
			const fragment = await (await pickerFor(monthChipRequest)).text();
			const swapped = page.replace(pickerSection(page), () => fragment);
			expect(swapped.match(/<main/g)).toHaveLength(1);
			expect(swapped.match(/id="announcer"/g)).toHaveLength(1);
			expect(swapped.match(/id="payment-picker"/g)).toHaveLength(1);
		});

		it("keeps focus on the chosen month and does not autofocus the section on a re-render", async () => {
			const html = await (await pickerFor(monthChipRequest)).text();
			const section = html.match(/<section[^>]*>/)?.[0] ?? "";
			expect(section).not.toContain("autofocus");
			const focused = html.match(/<input[^>]*autofocus[^>]*>/g) ?? [];
			expect(focused).toHaveLength(1);
			expect(focused[0]).toContain(`name="period" value="${period}"`);
		});

		it("still autofocuses the section when the page opens on its picker", async () => {
			const res = await pickerFor();
			const page = await res.text();
			expect(page.match(/<section id="payment-picker"[^>]*>/)?.[0]).toContain(
				"autofocus",
			);
			expect(pickerSection(page)).not.toMatch(/<input[^>]*autofocus/);
			// A full page open announces nothing; only a month choice's swap does.
			const trigger = res.headers.get("HX-Trigger");
			expect(trigger === null ? {} : JSON.parse(trigger)).not.toHaveProperty(
				"announce",
			);
		});

		it("announces the new candidate count once, through the announcer", async () => {
			const res = await pickerFor(monthChipRequest);
			const html = await res.text();
			const count = (html.match(/name="transaction_id" value="/g) ?? []).length;
			expect(count).toBeGreaterThanOrEqual(2);
			// The picker arrives whole, so a live line inside it isn't reliably spoken: the count goes to the announcer only.
			expect(html).not.toContain(`${count} payments to link`);
			expect(html).not.toContain("payments to link");
			expect(html).toContain(
				'<div id="bill-month-explanation" aria-live="polite">',
			);
			const line =
				html.match(
					/<div id="bill-month-explanation" aria-live="polite">([\s\S]*?)<\/div>/,
				)?.[1] ?? "";
			expect(line).not.toContain('class="sr-only"');
			expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
				announce: `${count} payments to link`,
			});
		});

		it("keeps the month choices, with focus on the chosen one, when that month has no payments to link", async () => {
			// Income can't pay a bill, so flagging everything within 30 days of November's due date (Nov 15) leaves no payment.
			await env.DB.prepare(
				"UPDATE transactions SET flag_income=1 WHERE date BETWEEN '2026-10-16' AND '2026-12-15'",
			).run();
			const chosen = "2026-11";
			const otherMonth = await (await pickerFor(monthChipRequest)).text();
			const res = await pickerFor(monthChipRequest, chosen);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html.match(/name="transaction_id"/g)).toBeNull();
			expect(html).toContain(`name="period" value="${chosen}"`);
			expect(html.match(/name="period" value="/g)).toHaveLength(
				otherMonth.match(/name="period" value="/g)?.length ?? -1,
			);
			const focused = html.match(/<input[^>]*autofocus[^>]*>/g) ?? [];
			expect(focused).toHaveLength(1);
			expect(focused[0]).toContain(`name="period" value="${chosen}"`);
			// The visible empty state says it once; the count reaches screen readers through the announcer only.
			expect(html.match(/No payments to link/g)).toHaveLength(1);
			expect(html).toContain(
				'<div id="bill-month-explanation" aria-live="polite">',
			);
			const line =
				html.match(
					/<div id="bill-month-explanation" aria-live="polite">([\s\S]*?)<\/div>/,
				)?.[1] ?? "";
			expect(line).not.toContain("No payments to link");
			expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
				announce: "No payments to link",
			});
		});

		it("shows only the empty state when the page opens on a month with no payments to link", async () => {
			// The same setup as above: nothing within 30 days of November's due date can pay the bill.
			await env.DB.prepare(
				"UPDATE transactions SET flag_income=1 WHERE date BETWEEN '2026-10-16' AND '2026-12-15'",
			).run();
			const page = await (await pickerFor({}, "2026-11")).text();
			const section = pickerSection(page);
			expect(section).toContain("No payments to link");
			expect(section).not.toContain('name="period"');
			expect(section).not.toContain('id="bill-month-explanation"');
		});
	});

	it("refreshes candidates and explanation when the chosen month changes", async () => {
		const period = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1").run();
		const html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${period}/link`,
			)
		).text();
		expect(html).toContain('hx-target="#payment-picker"');
		expect(html).toContain(
			'hx-include="[name=&#39;transaction_id&#39;],[name=&#39;period&#39;]"',
		);
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain(
			"A late payment counts in its bill&#39;s month; an early one stays in the month it was paid.",
		);
	});

	it("reports the selected month when a payment is outside its 30-day window", async () => {
		const period = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		await env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1").run();
		const old = await env.DB.prepare(
			"SELECT id FROM transactions ORDER BY date LIMIT 1",
		).first<number>("id");
		const res = await exports.default.fetch("http://tally.test/bills/1/link", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
			},
			body: new URLSearchParams({
				transaction_id: String(old),
				period,
				opened_period: period,
			}),
		});
		expect(await res.text()).toContain(
			`That payment isn&#39;t within 30 days of`,
		);
	});

	it("lists only unpaid month choices and captions monthly payments", async () => {
		const linked = await env.DB.prepare(
			"SELECT period FROM bill_payments WHERE bill_id=1 AND status='linked' LIMIT 1",
		).first<{ period: string }>();
		const html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${linked?.period}/link`,
			)
		).text();
		expect(html).toContain("Which month&#39;s bill does it pay?");
		expect(html).not.toContain(`name="period" value="${linked?.period}"`);
		expect(html).toContain("A late payment counts in its bill&#39;s month");
		expect(html).toMatch(/To [A-Z][a-z]+&#39;s Streaming, \$2\.99\./);
		expect(html).toMatch(
			/Within 30 days of [A-Z][a-z]{2} \d{1,2}, same merchant first, then closest amount\./,
		);
		expect(html).toContain("an early one stays in the month it was paid");
	});

	it("bill rows use drawn statuses, compact month labels, actions, and guidance", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills/1")
		).text();
		expect(html).toContain("rounded-control bg-band");
		expect(html).toContain('class="size-4"');
		expect(html).toContain("-ml-2");
		expect(html).toContain("Deactivate");
		expect(html).toContain("&quot;Not this one&quot;");
		expect(html).not.toContain("· matched");
	});

	it("returns typed toast and announcement headers for htmx unlink and link", async () => {
		const linked = await env.DB.prepare(
			"SELECT period,transaction_id FROM bill_payments WHERE bill_id=1 AND status='linked' LIMIT 1",
		).first<{ period: string; transaction_id: number }>();
		const unlink = await exports.default.fetch(
			`http://tally.test/bills/1/occurrences/${linked?.period}/unlink`,
			{
				method: "POST",
				headers: { Origin: "http://tally.test", "HX-Request": "true" },
			},
		);
		const unlinkTrigger = JSON.parse(unlink.headers.get("HX-Trigger") ?? "{}");
		expect(unlinkTrigger.toast).toMatchObject({
			message: "Payment unlinked",
			type: "success",
			undoAction: "/bills/1/undo-unlink",
		});
		expect(unlinkTrigger.announce).toBe(
			"Payment unlinked. Undo for 10 seconds.",
		);
		const link = await exports.default.fetch("http://tally.test/bills/1/link", {
			method: "POST",
			headers: {
				Origin: "http://tally.test",
				"HX-Request": "true",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				transaction_id: String(linked?.transaction_id),
				period: String(linked?.period),
				opened_period: String(linked?.period),
			}),
		});
		expect(JSON.parse(link.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Payment linked", type: "success" },
			announce: "Payment linked",
		});
	});

	it("re-links a hand-linked payment to the new bill category, keeps manual choices, and leaves its category on unlink", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const period = today.slice(0, 7);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare(
				"UPDATE bills SET due_day=?,frequency='monthly',category_id=1 WHERE id=1",
			).bind(Number(today.slice(8, 10))),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9200,'Second bill',10000,?,'monthly',2,'SECOND BILL')",
			).bind(Number(today.slice(8, 10))),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source,category_confidence,jev_category_id) SELECT 9200,id,?,10000,'HAND LINK',3,'jev',0.72,3 FROM accounts LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9201,id,?,10000,'USER CHOICE',3,'user' FROM accounts LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9202,id,?,10000,'MERCHANT RULE',3,'merchant_rule' FROM accounts LIMIT 1",
			).bind(today),
		]);
		const link = (bill: number, transaction: number) =>
			exports.default.fetch(`http://tally.test/bills/${bill}/link`, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Origin: "http://tally.test",
				},
				body: new URLSearchParams({
					transaction_id: String(transaction),
					period,
					opened_period: period,
				}),
			});

		await link(1, 9200);
		expect(
			await env.DB.prepare(
				"SELECT category_id,category_source FROM transactions WHERE id=9200",
			).first(),
		).toEqual({ category_id: 1, category_source: "bill" });

		await exports.default.fetch(
			`http://tally.test/bills/1/occurrences/${period}/unlink`,
			{ method: "POST", headers: { Origin: "http://tally.test" } },
		);
		expect(
			await env.DB.prepare(
				"SELECT category_id,category_source FROM transactions WHERE id=9200",
			).first(),
		).toEqual({ category_id: 1, category_source: "bill" });

		await env.DB.prepare(
			"UPDATE transactions SET category_id=3,category_source='jev' WHERE id=9200",
		).run();
		await link(9200, 9200);
		await link(1, 9201);
		await link(1, 9202);
		await link(9200, 9201);
		await link(9200, 9202);
		expect(
			(
				await env.DB.prepare(
					"SELECT id,category_id AS categoryId,category_source AS categorySource FROM transactions WHERE id BETWEEN 9200 AND 9202 ORDER BY id",
				).all()
			).results,
		).toEqual([
			{ id: 9200, categoryId: 2, categorySource: "bill" },
			{ id: 9201, categoryId: 3, categorySource: "user" },
			{ id: 9202, categoryId: 3, categorySource: "merchant_rule" },
		]);
		for (const id of [9201, 9202]) {
			await exports.default.fetch(
				`http://tally.test/bills/9200/occurrences/${period}/unlink`,
				{ method: "POST", headers: { Origin: "http://tally.test" } },
			);
			expect(
				await env.DB.prepare(
					"SELECT category_id,category_source FROM transactions WHERE id=?",
				)
					.bind(id)
					.first(),
			).toEqual({
				category_id: 3,
				category_source: id === 9201 ? "user" : "merchant_rule",
			});
		}
	});

	it("gives an uncategorized hand-linked payment the bill category and reduces Home's Needs category count", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const period = today.slice(0, 7);
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare(
				"UPDATE bills SET due_day=?,category_id=5 WHERE id=1",
			).bind(Number(today.slice(8, 10))),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9300,'Second category bill',10000,?,'monthly',2,'SECOND CATEGORY BILL')",
			).bind(Number(today.slice(8, 10))),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9300,id,?,10000,'UNCATEGORIZED BILL' FROM accounts LIMIT 1",
			).bind(today),
		]);
		const count = async () => {
			const html = await (
				await exports.default.fetch("http://tally.test/")
			).text();
			return Number(
				html.match(/(\\d+) transactions need\\s+a\\s+category/)?.[1],
			);
		};
		const before = await count();
		const res = await exports.default.fetch("http://tally.test/bills/1/link", {
			method: "POST",
			headers: {
				Origin: "http://tally.test",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				transaction_id: "9300",
				period,
				opened_period: period,
			}),
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT category_id,category_source FROM transactions WHERE id=9300",
			).first(),
		).toEqual({ category_id: 5, category_source: "bill" });
		expect(await count()).toBe(before - 1);
		await env.DB.prepare(
			"UPDATE transactions SET category_id=NULL,category_source=NULL WHERE id=9300",
		).run();
		await exports.default.fetch(
			`http://tally.test/bills/1/occurrences/${period}/unlink`,
			{ method: "POST", headers: { Origin: "http://tally.test" } },
		);
		const relink = await exports.default.fetch(
			"http://tally.test/bills/9300/link",
			{
				method: "POST",
				headers: {
					Origin: "http://tally.test",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					transaction_id: "9300",
					period,
					opened_period: period,
				}),
			},
		);
		expect(relink.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT category_id,category_source FROM transactions WHERE id=9300",
			).first(),
		).toEqual({ category_id: 2, category_source: "bill" });
	});

	it.each([
		["none", null, null],
		["jev", 2, "jev"],
		["earlier bill", 1, "bill"],
		["user", 3, "user"],
		["merchant rule", 4, "merchant_rule"],
	] as const)(
		"leaves a linked payment's %s category unchanged on unlink",
		async (_label, categoryId, source) => {
			const today = todayIn(DEFAULT_TIME_ZONE);
			const period = today.slice(0, 7);
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bill_payments"),
				env.DB.prepare("UPDATE bills SET due_day=? WHERE id=1").bind(
					Number(today.slice(8, 10)),
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9400,id,?,10000,'UNLINK SOURCE' FROM accounts LIMIT 1",
				).bind(today),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,?,9400,'user','linked')",
				).bind(period),
				env.DB.prepare(
					"UPDATE transactions SET category_id=?,category_source=? WHERE id=9400",
				).bind(categoryId, source),
			]);
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${period}/unlink`,
				{ method: "POST", headers: { Origin: "http://tally.test" } },
			);
			expect(
				await env.DB.prepare(
					"SELECT category_id,category_source FROM transactions WHERE id=9400",
				).first(),
			).toEqual({ category_id: categoryId, category_source: source });
		},
	);

	it("picker uses a 30-day window, preferred order, every eligible payment, and exclusions", async () => {
		const today = todayIn(DEFAULT_TIME_ZONE);
		const period = today.slice(0, 7);
		const day = Number(today.slice(8, 10));
		await env.DB.batch([
			env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=1"),
			// Its amount history goes too: this fixture sets the bill's own amount, which then applies to every month.
			env.DB.prepare("DELETE FROM bill_amounts WHERE bill_id=1"),
			env.DB.prepare(
				"UPDATE bills SET due_day=?,amount_cents=1000,frequency='monthly',merchant_raw_name='PREFERRED' WHERE id=1",
			).bind(day),
		]);
		const statements = [];
		for (let i = 0; i < 55; i++)
			statements.push(
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,?,? FROM accounts LIMIT 1",
				).bind(
					1000 + i,
					today,
					1000 + i,
					i === 54 ? "PREFERRED" : `CANDIDATE ${i}`,
				),
			);
		statements.push(
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,flag_income) SELECT 1100,id,?,1000,'INCOME',1 FROM accounts LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 1101,id,date(?, '-31 day'),1000,'TOO OLD' FROM accounts LIMIT 1",
			).bind(today),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(1,?,1001,'user','dismissed')",
			).bind(period),
		);
		await env.DB.batch(statements);
		const html = await (
			await exports.default.fetch(
				`http://tally.test/bills/1/occurrences/${period}/link`,
			)
		).text();
		// Every eligible payment stays reachable, even the furthest in amount, and the one the person said Not this one
		// to stays listed last, under "You said not this one" (#340).
		expect(
			html.match(/name="transaction_id" value="10\d\d"/g) ?? [],
		).toHaveLength(55);
		expect(html).not.toContain("INCOME");
		expect(html).not.toContain("TOO OLD");
		const picker = html.slice(html.indexOf('<section id="payment-picker"'));
		expect(picker.indexOf('value="1054"')).toBeLessThan(
			picker.indexOf('value="1000"'),
		);
		expect(picker.indexOf("You said not this one")).toBeGreaterThan(
			picker.indexOf('value="1054"'),
		);
		expect(picker.indexOf('value="1001"')).toBeGreaterThan(
			picker.indexOf("You said not this one"),
		);
	});

	it("returns 404 for a malformed occurrence period", async () => {
		expect(
			(
				await exports.default.fetch(
					"http://tally.test/bills/1/occurrences/not-a-month/link",
				)
			).status,
		).toBe(404);
	});

	describe("a payment's own name shows as typed (decision 101)", () => {
		const period = todayIn(DEFAULT_TIME_ZONE).slice(0, 7);
		const due = `${period}-15`;
		/** A monthly bill due on the 15th, and nothing else until a test adds the transactions it needs. */
		const bill = [
			env.DB.prepare("DELETE FROM bill_payments"),
			env.DB.prepare("DELETE FROM bills"),
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(9400,'Streaming',1500,15,'monthly','AMAZON')",
			),
		];
		const bankAmazon = (id: number, ownName: string | null, extra = "") =>
			env.DB.prepare(
				`INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,own_name${extra ? ",is_split" : ""})
				 SELECT ?,id,?,1500,'AMZN MKTP US*2K4',?${extra ? ", 1" : ""} FROM accounts LIMIT 1`,
			).bind(id, due, ownName);
		const pickerHtml = async () =>
			(
				await exports.default.fetch(
					`http://tally.test/bills/9400/occurrences/${period}/link`,
				)
			).text();

		it("shows a linked payment's own name on its occurrence row", async () => {
			await env.DB.batch([
				...bill,
				bankAmazon(9401, "DOG BED"),
				env.DB.prepare(
					"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9400,?,9401,'user','linked')",
				).bind(period),
			]);
			// The bill's page lists each occurrence with the payment that paid it.
			const html = await (
				await exports.default.fetch("http://tally.test/bills/9400")
			).text();
			expect(html).toContain("DOG BED");
			expect(html).not.toContain("Amzn mktp");
		});

		it("lists a candidate that has its own name by that name, exactly as typed", async () => {
			await env.DB.batch([...bill, bankAmazon(9401, "DOG BED")]);
			const picker = (await pickerHtml()).split(
				'<section id="payment-picker"',
			)[1];
			expect(picker).toContain('value="9401"');
			expect(picker).toContain("DOG BED");
			expect(picker).not.toContain("Amzn mktp");
		});

		it("lists a split part with no name of its own under its purchase's own name", async () => {
			await env.DB.batch([
				...bill,
				bankAmazon(9401, "DOG BED", "split"),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name,parent_id) SELECT 9402,id,?,1500,'AMZN MKTP US*2K4',9401 FROM accounts LIMIT 1",
				).bind(due),
			]);
			const picker = (await pickerHtml()).split(
				'<section id="payment-picker"',
			)[1];
			expect(picker).toContain('value="9402"');
			expect(picker).toContain("DOG BED");
			expect(picker).not.toContain("Amzn mktp");
		});
	});
});

// Spec §8.5, decision 72 (P45 A): no two active bills share a name, and an amount over $100,000
// is saved only once a "Yes, $X is right" chip for that exact amount is ticked.
describe("Bill guards", () => {
	beforeEach(() => resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE)));

	const fields = (over: Record<string, string> = {}) =>
		new URLSearchParams({
			name: "Gym",
			amount: "42.50",
			due_day: "12",
			frequency: "monthly",
			anchor_month: "1",
			category_id: "5",
			merchant_raw_name: "CITY GYM",
			...over,
		});
	const post = (path: string, body: URLSearchParams, htmx = true) =>
		exports.default.fetch(`http://tally.test${path}`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Origin: "http://tally.test",
				...(htmx ? { "HX-Request": "true" } : {}),
			},
			body,
		});
	const billCount = async () =>
		(
			await env.DB.prepare("SELECT COUNT(*) AS n FROM bills").first<{
				n: number;
			}>()
		)?.n;
	const nameOf = async (id: number) =>
		env.DB.prepare("SELECT name FROM bills WHERE id=?").bind(id).first("name");
	const amountOf = async (id: number) =>
		env.DB.prepare("SELECT amount_cents FROM bills WHERE id=?")
			.bind(id)
			.first("amount_cents");
	/** The confirm chip's input tag, or undefined when the form has none. */
	const confirmChip = (html: string) =>
		html.match(/<input[^>]*name="confirm_amount"[^>]*>/)?.[0];

	describe("duplicate names", () => {
		it.each([
			["the same name", "Streaming"],
			["another case", "STREAMING"],
			["spaces around it", "  streaming  "],
		])("refuses adding %s as an active bill", async (_label, name) => {
			const before = await billCount();
			const res = await post("/bills", fields({ name }));
			const html = await res.text();
			expect(res.status).toBe(200);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Streaming.");
			expect(html).toMatch(
				/<p id="bill-name-error" role="alert"[^>]*>You already have a bill called Streaming\.<\/p>/,
			);
			expect(html).toMatch(
				/<input[^>]*id="bill-name"[^>]*aria-describedby="bill-name-error"/,
			);
			// The form comes back with what was typed, ready to fix.
			expect(html).toContain('id="bill-sheet-title"');
			expect(html).toContain('value="CITY GYM"');
			expect(await billCount()).toBe(before);
		});

		it("refuses it without JavaScript the same way", async () => {
			const before = await billCount();
			const res = await post("/bills", fields({ name: "water" }), false);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("<form");
			expect(html).toContain('role="alert"');
			expect(html).toContain("You already have a bill called Water.");
			expect(await billCount()).toBe(before);
		});

		it("lets a bill keep its own name when it is edited", async () => {
			for (const name of ["Streaming", "  streaming ", "STREAMING"]) {
				const res = await post(
					"/bills/1",
					fields({ name, amount: "3.99", merchant_raw_name: "APPLE.COM/BILL" }),
				);
				expect(res.headers.get("HX-Trigger")).toContain(
					'"announce":"Bill saved"',
				);
				expect(await nameOf(1)).toBe(name.trim());
			}
		});

		it("refuses editing a bill to another active bill's name", async () => {
			const res = await post(
				"/bills/1",
				fields({ name: " water", merchant_raw_name: "APPLE.COM/BILL" }),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Water.");
			expect(await nameOf(1)).toBe("Streaming");
		});

		describe("bills that already share a name", () => {
			// Two active Rent bills, as a family's data may already hold. Daycare uses id 8.
			beforeEach(async () => {
				for (const merchant of ["LANDLORD", "LANDLORD 2"])
					await env.DB.prepare(
						`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
						 VALUES('Rent',100000,1,'monthly',5,?)`,
					)
						.bind(merchant)
						.run();
			});
			const rentIds = [9, 10];
			const edit = (id: number, over: Record<string, string>) =>
				post(
					`/bills/${id}`,
					fields({
						name: "Rent",
						amount: "1200.00",
						due_day: "1",
						merchant_raw_name: id === 9 ? "LANDLORD" : "LANDLORD 2",
						...over,
					}),
				);

			it.each(rentIds)("still lets bill %i's amount be changed", async (id) => {
				const res = await edit(id, { amount: "1250.00" });
				expect(res.headers.get("HX-Trigger")).toContain(
					'"announce":"Bill saved"',
				);
				expect(await amountOf(id)).toBe(125000);
				expect(await nameOf(id)).toBe("Rent");
			});

			it.each(rentIds)(
				"still refuses renaming bill %i to a third bill's name",
				async (id) => {
					const res = await edit(id, { name: "water" });
					const html = await res.text();
					expect(res.headers.get("HX-Trigger")).toBeNull();
					expect(html).toContain("You already have a bill called Water.");
					expect(await nameOf(id)).toBe("Rent");
				},
			);

			it("still refuses adding another bill with the shared name", async () => {
				const res = await post("/bills", fields({ name: "RENT" }));
				expect(res.headers.get("HX-Trigger")).toBeNull();
				expect(await res.text()).toContain(
					"You already have a bill called Rent.",
				);
			});
		});

		it("compares names as the database does: spaces and A to Z only", async () => {
			const add = (name: string) =>
				post("/bills", fields({ name, merchant_raw_name: name }));
			expect((await add("Café")).headers.get("HX-Trigger")).toContain(
				"Bill added",
			);
			// É is a different letter from é, in the form and in the write alike.
			expect((await add("CAFÉ")).headers.get("HX-Trigger")).toContain(
				"Bill added",
			);
			// Rent and " RENT " are the same name in both.
			expect((await add("Rent")).headers.get("HX-Trigger")).toContain(
				"Bill added",
			);
			const again = await add(" RENT ");
			expect(again.headers.get("HX-Trigger")).toBeNull();
			expect(await again.text()).toContain(
				"You already have a bill called Rent.",
			);
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE active=1 AND name IN ('Café','CAFÉ','Rent')",
				).first("n"),
			).toBe(3);
		});

		it("lets an add reuse an inactive bill's name", async () => {
			const res = await post(
				"/bills",
				fields({ name: "old PHONE plan", merchant_raw_name: "PHONE CO" }),
			);
			expect(res.headers.get("HX-Trigger")).toContain("Bill added");
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE name='old PHONE plan' AND active=1",
				).first("n"),
			).toBe(1);
		});

		it("refuses reactivating a bill that would duplicate an active one", async () => {
			await env.DB.prepare(
				`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
				 VALUES('old phone plan',4000,3,'monthly',5,'PHONE CO')`,
			).run();
			for (const htmx of [true, false]) {
				const res = await post(
					"/bills/7/reactivate",
					new URLSearchParams(),
					htmx,
				);
				const html = await res.text();
				expect(res.status).toBe(200);
				expect(res.headers.get("HX-Trigger")).toBeNull();
				expect(html).toContain(
					"You already have a bill called old phone plan.",
				);
				expect(html).toMatch(/<p id="bill-name-error" role="alert"/);
				expect(
					await env.DB.prepare("SELECT active FROM bills WHERE id=7").first(
						"active",
					),
				).toBe(0);
			}
		});

		it("reactivates an inactive bill when no active bill has its name", async () => {
			const res = await post("/bills/7/reactivate", new URLSearchParams());
			expect(res.headers.get("HX-Trigger")).toContain("Bill reactivated");
			expect(
				await env.DB.prepare("SELECT active FROM bills WHERE id=7").first(
					"active",
				),
			).toBe(1);
		});

		it("still refuses reactivating a missing bill with a 404", async () => {
			expect(
				(await post("/bills/999999/reactivate", new URLSearchParams())).status,
			).toBe(404);
		});
	});

	// Two saves can both pass the form's check; the write itself then refuses the second.
	describe("a duplicate that lands between the check and the write", () => {
		const competing = (name: string) =>
			`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES('${name}',1000,1,'monthly',5,'RIVAL CO')`;
		/** The worker's env with a DB that runs `rival` just before the first statement starting with `sql` runs. */
		const racing = (sql: string, rival: string) => {
			let raced = false;
			const guard = (statement: D1PreparedStatement): D1PreparedStatement => {
				const proxy: D1PreparedStatement = new Proxy(statement, {
					get(target, prop) {
						if (prop === "bind")
							return (...values: unknown[]) => {
								const bound = guard(target.bind(...values));
								if (matched.has(proxy)) matched.add(bound);
								return bound;
							};
						if (prop === "run")
							return async () => {
								if (!raced) {
									raced = true;
									await env.DB.prepare(rival).run();
								}
								return target.run();
							};
						const value = Reflect.get(target, prop);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				wrapped.set(proxy, statement);
				return proxy;
			};
			// A save's bill and its amount row go in one batch, so the rival also lands just before a batch
			// that holds a matching statement; the batch itself gets the real statements.
			const matched = new Set<D1PreparedStatement>();
			const wrapped = new Map<D1PreparedStatement, D1PreparedStatement>();
			const rivalFirst = async () => {
				if (!raced) {
					raced = true;
					await env.DB.prepare(rival).run();
				}
			};
			const DB = new Proxy(env.DB, {
				get(target, prop) {
					if (prop === "prepare")
						return (text: string) => {
							const statement = target.prepare(text);
							if (!text.startsWith(sql)) return statement;
							const proxy = guard(statement);
							matched.add(proxy);
							return proxy;
						};
					if (prop === "batch")
						return async (statements: D1PreparedStatement[]) => {
							if (statements.some((s) => matched.has(s))) await rivalFirst();
							return target.batch(statements.map((s) => wrapped.get(s) ?? s));
						};
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			return { ...env, DB };
		};
		const send = (path: string, body: URLSearchParams, worker: Env) =>
			app.request(
				`http://tally.test${path}`,
				{
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						"HX-Request": "true",
						Origin: "http://tally.test",
					},
					body,
				},
				worker,
			);
		const gyms = async () =>
			(
				await env.DB.prepare(
					"SELECT name FROM bills WHERE lower(name)='gym' AND active=1",
				).all<{ name: string }>()
			).results.map((r) => r.name);

		it("refuses an add, and shows the Name error", async () => {
			const res = await send(
				"/bills",
				fields({ name: "Gym" }),
				racing("INSERT INTO bills", competing("gym")),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called gym.");
			expect(html).toMatch(/<p id="bill-name-error" role="alert"/);
			expect(await gyms()).toEqual(["gym"]);
		});

		it("refuses an edit, and leaves the bill as it was", async () => {
			const res = await send(
				"/bills/1",
				fields({ name: "Gym", merchant_raw_name: "APPLE.COM/BILL" }),
				racing("UPDATE bills SET name", competing("gym")),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called gym.");
			expect(await nameOf(1)).toBe("Streaming");
			expect(await amountOf(1)).toBe(299);
			expect(await gyms()).toEqual(["gym"]);
		});

		it("refuses a reactivation", async () => {
			const res = await send(
				"/bills/7/reactivate",
				new URLSearchParams(),
				racing("UPDATE bills SET active", competing("Old phone plan")),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Old phone plan.");
			expect(
				await env.DB.prepare("SELECT active FROM bills WHERE id=7").first(
					"active",
				),
			).toBe(0);
		});
	});

	// When reactivating is refused, the Name field is the way out: rename it, then Reactivate.
	describe("renaming while reactivating", () => {
		const repeatActive = () =>
			env.DB.prepare(
				`INSERT INTO bills(name,amount_cents,due_day,frequency,category_id,merchant_raw_name)
				 VALUES('old phone plan',4000,3,'monthly',5,'PHONE CO')`,
			).run();
		const statusOf = (id: number) =>
			env.DB.prepare("SELECT name,active FROM bills WHERE id=?")
				.bind(id)
				.first<{ name: string; active: number }>();

		it("makes Reactivate send the typed name only after a refusal", async () => {
			const plain = await (
				await exports.default.fetch("http://tally.test/bills/7/edit")
			).text();
			expect(plain).toContain('formaction="/bills/7/reactivate"');
			expect(plain).not.toContain("reactivate?rename");
			await repeatActive();
			const refused = await (
				await post("/bills/7/reactivate", new URLSearchParams())
			).text();
			expect(refused).toContain('formaction="/bills/7/reactivate?rename=1"');
			expect(refused).toContain('hx-post="/bills/7/reactivate?rename=1"');
			// The sheet's Name field holds the bill's name, ready to be changed.
			expect(refused).toMatch(
				/<input[^>]*id="bill-name"[^>]*value="Old phone plan"/,
			);
		});

		it("renames and reactivates in one step when the new name is free", async () => {
			await repeatActive();
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "  Old phone plan (2022) " }),
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				'"announce":"Bill reactivated"',
			);
			expect(await statusOf(7)).toEqual({
				name: "Old phone plan (2022)",
				active: 1,
			});
		});

		it("redirects the same way without JavaScript", async () => {
			await repeatActive();
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "Old phone plan (2022)" }),
				false,
			);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/bills");
			expect(await statusOf(7)).toEqual({
				name: "Old phone plan (2022)",
				active: 1,
			});
		});

		it("refuses again when the typed name is also taken, keeping what was typed", async () => {
			await repeatActive();
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "WATER" }),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("You already have a bill called Water.");
			expect(html).toMatch(/<input[^>]*id="bill-name"[^>]*value="WATER"/);
			expect(html).toContain('formaction="/bills/7/reactivate?rename=1"');
			expect(await statusOf(7)).toEqual({ name: "Old phone plan", active: 0 });
		});

		it("asks for a name when the Name field was emptied", async () => {
			const res = await post(
				"/bills/7/reactivate?rename=1",
				new URLSearchParams({ name: "  " }),
			);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await res.text()).toContain("Enter a name.");
			expect(await statusOf(7)).toEqual({ name: "Old phone plan", active: 0 });
		});

		it("does not rename on a plain Reactivate", async () => {
			const res = await post(
				"/bills/7/reactivate",
				new URLSearchParams({ name: "Something else" }),
			);
			expect(res.headers.get("HX-Trigger")).toContain("Bill reactivated");
			expect(await statusOf(7)).toEqual({ name: "Old phone plan", active: 1 });
		});
	});

	describe("reactivating links the payments that arrived while the bill was off", () => {
		// Today is 14 October 2026 and the bill is due on the 12th. Its payment came on the 11th, while it was off.
		const linkedPayments = async (billId: number) =>
			(
				await env.DB.prepare(
					"SELECT period, transaction_id AS transactionId FROM bill_payments WHERE bill_id=? AND status='linked' ORDER BY period",
				)
					.bind(billId)
					.all<{ period: string; transactionId: number }>()
			).results;
		const pageText = async (path: string) =>
			(await exports.default.fetch(`http://tally.test${path}`)).text();

		beforeEach(async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-14T16:00:00Z"));
			await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
			await env.DB.batch([
				env.DB.prepare("DELETE FROM bills"),
				env.DB.prepare("DELETE FROM bill_payments"),
				env.DB.prepare(
					"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,active,added_on) VALUES(9801,'Reactivate fixture',4500,12,'monthly',5,'REACTIVATE FIXTURE',0,'2026-09-01')",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9801,1,'2026-10-11',4500,'REACTIVATE FIXTURE')",
				),
			]);
		});
		afterEach(() => vi.useRealTimers());

		it("links the payment, shows the bill Paid, and leaves it out of Home's bills due soon", async () => {
			expect(await linkedPayments(9801)).toEqual([]);
			const res = await post("/bills/9801/reactivate", new URLSearchParams());
			expect(res.headers.get("HX-Trigger")).toContain("Bill reactivated");
			expect(await linkedPayments(9801)).toEqual([
				{ period: "2026-10", transactionId: 9801 },
			]);
			const bills = await pageText("/bills");
			expect(bills).toContain("Paid this month");
			expect(bills).not.toContain("Overdue");
			expect(await pageText("/")).not.toContain("Bills due soon");
		});

		it("still sets a reactivated bill with no payment aside on Home", async () => {
			// The control for the test above: without its payment, the overdue bill is set aside.
			await env.DB.prepare("DELETE FROM transactions WHERE id=9801").run();
			await post("/bills/9801/reactivate", new URLSearchParams());
			expect(await linkedPayments(9801)).toEqual([]);
			const home = await pageText("/");
			expect(home).toContain("Bills due soon");
			expect(home).toContain("Reactivate fixture");
		});

		it("matches each occurrence at its own month's amount (decision 101)", async () => {
			// September's occurrence was 40.00; the amount changed to 45.00 from October on.
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO bill_amounts(bill_id,effective_month,amount_cents) VALUES(9801,'2026-08',4000),(9801,'2026-10',4500)",
				),
				env.DB.prepare(
					"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) VALUES(9802,1,'2026-09-13',4000,'REACTIVATE FIXTURE')",
				),
			]);
			await post("/bills/9801/reactivate", new URLSearchParams());
			expect(await linkedPayments(9801)).toEqual([
				{ period: "2026-09", transactionId: 9802 },
				{ period: "2026-10", transactionId: 9801 },
			]);
		});

		it("keeps a payment for an occurrence due before the bill was added as Paid (decision 99)", async () => {
			// Added on the 13th, after this month's due date: the payment still pays the 12th's occurrence.
			await env.DB.prepare(
				"UPDATE bills SET added_on='2026-10-13' WHERE id=9801",
			).run();
			await post("/bills/9801/reactivate", new URLSearchParams());
			expect(await linkedPayments(9801)).toEqual([
				{ period: "2026-10", transactionId: 9801 },
			]);
			const bills = await pageText("/bills");
			expect(bills).toContain("Paid this month");
			expect(bills).not.toContain("Overdue");
		});

		it("links nothing when the reactivation is refused for a name an active bill has", async () => {
			await env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9810,'reactivate FIXTURE',4000,3,'monthly',5,'OTHER PLACE')",
			).run();
			const res = await post("/bills/9801/reactivate", new URLSearchParams());
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await linkedPayments(9801)).toEqual([]);
		});
	});

	describe("amounts over $100,000.00", () => {
		it("comes back with the alert line and an unticked chip, and saves nothing", async () => {
			const before = await billCount();
			const res = await post(
				"/bills",
				fields({ name: "Rent", amount: "150000.00" }),
			);
			const html = await res.text();
			expect(res.status).toBe(200);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await billCount()).toBe(before);
			expect(html).toMatch(
				/<p id="bill-amount-error" role="alert"[^>]*>\$150,000\.00 is a lot for a bill\.<\/p>/,
			);
			const chip = confirmChip(html);
			expect(chip).toContain('type="checkbox"');
			expect(chip).toContain('value="15000000"');
			expect(chip).toContain('aria-describedby="bill-amount-error"');
			expect(chip).not.toContain("checked");
			expect(html).toContain("Yes, $150,000.00 is right");
			// The form keeps what was typed.
			expect(html).toContain('value="150000.00"');
		});

		it("does not ask at exactly $100,000.00, and asks one cent over", async () => {
			const exact = await post(
				"/bills",
				fields({ name: "Land", amount: "100,000.00" }),
			);
			expect(exact.headers.get("HX-Trigger")).toContain("Bill added");
			expect(
				await env.DB.prepare(
					"SELECT amount_cents FROM bills WHERE name='Land'",
				).first("amount_cents"),
			).toBe(10_000_000);
			const over = await post(
				"/bills",
				fields({ name: "Land 2", amount: "100000.01" }),
			);
			expect(over.headers.get("HX-Trigger")).toBeNull();
			expect(await over.text()).toContain("$100,000.01 is a lot for a bill.");
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE name='Land 2'",
				).first("n"),
			).toBe(0);
		});

		it("saves once the chip for that amount is ticked", async () => {
			const res = await post(
				"/bills",
				fields({
					name: "Rent",
					amount: "150000.00",
					confirm_amount: "15000000",
				}),
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				'"announce":"Bill added"',
			);
			expect(
				await env.DB.prepare(
					"SELECT amount_cents FROM bills WHERE name='Rent'",
				).first("amount_cents"),
			).toBe(15_000_000);
		});

		it("asks again when the amount changed after confirming", async () => {
			const before = await billCount();
			const res = await post(
				"/bills",
				fields({
					name: "Rent",
					amount: "200000.00",
					confirm_amount: "15000000",
				}),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await billCount()).toBe(before);
			expect(html).toContain("$200,000.00 is a lot for a bill.");
			expect(html).toContain("Yes, $200,000.00 is right");
			const chip = confirmChip(html);
			expect(chip).toContain('value="20000000"');
			expect(chip).not.toContain("checked");
		});

		it("does not take any other value as a confirmation", async () => {
			for (const confirm_amount of ["on", "1", "150000.00", ""]) {
				const res = await post(
					"/bills",
					fields({ name: "Rent", amount: "150000.00", confirm_amount }),
				);
				expect(res.headers.get("HX-Trigger")).toBeNull();
			}
			expect(
				await env.DB.prepare(
					"SELECT COUNT(*) AS n FROM bills WHERE name='Rent'",
				).first("n"),
			).toBe(0);
		});

		it("works without JavaScript: the form again, then a redirect once ticked", async () => {
			const asked = await post(
				"/bills",
				fields({ name: "Rent", amount: "150000" }),
				false,
			);
			expect(asked.status).toBe(200);
			const html = await asked.text();
			expect(html).toContain("<form");
			expect(html).toContain("Yes, $150,000.00 is right");
			const saved = await post(
				"/bills",
				fields({ name: "Rent", amount: "150000", confirm_amount: "15000000" }),
				false,
			);
			expect(saved.status).toBe(303);
			expect(saved.headers.get("location")).toBe("/bills");
		});

		it("asks when an edit makes the amount that big, and saves once confirmed", async () => {
			const edit = {
				name: "Streaming",
				amount: "150000.00",
				merchant_raw_name: "APPLE.COM/BILL",
			};
			const asked = await post("/bills/1", fields(edit));
			const html = await asked.text();
			expect(asked.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("$150,000.00 is a lot for a bill.");
			expect(confirmChip(html)).toContain('value="15000000"');
			expect(await amountOf(1)).toBe(299);
			const saved = await post(
				"/bills/1",
				fields({ ...edit, confirm_amount: "15000000" }),
			);
			expect(saved.headers.get("HX-Trigger")).toContain(
				'"announce":"Bill saved"',
			);
			expect(await amountOf(1)).toBe(15_000_000);
		});

		it("asks on every save of a bill over $100,000.00, even with the amount unchanged", async () => {
			await env.DB.prepare(
				"UPDATE bills SET amount_cents=20000000 WHERE id=1",
			).run();
			const edit = {
				name: "Streaming plus",
				amount: "200000.00",
				merchant_raw_name: "APPLE.COM/BILL",
			};
			const asked = await post("/bills/1", fields(edit));
			expect(asked.headers.get("HX-Trigger")).toBeNull();
			expect(await asked.text()).toContain("Yes, $200,000.00 is right");
			expect(await nameOf(1)).toBe("Streaming");
			const saved = await post(
				"/bills/1",
				fields({ ...edit, confirm_amount: "20000000" }),
			);
			expect(saved.headers.get("HX-Trigger")).toContain("Bill saved");
			expect(await nameOf(1)).toBe("Streaming plus");
		});

		it("keeps a ticked chip, without the alert, when another field needs fixing", async () => {
			const before = await billCount();
			const res = await post(
				"/bills",
				fields({
					name: "water",
					amount: "150000.00",
					confirm_amount: "15000000",
				}),
			);
			const html = await res.text();
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(await billCount()).toBe(before);
			expect(html).toContain("You already have a bill called Water.");
			expect(html).not.toContain("is a lot for a bill");
			expect(html).not.toContain('id="bill-amount-error"');
			const chip = confirmChip(html);
			expect(chip).toContain('value="15000000"');
			expect(chip).toContain("checked");
			expect(chip).not.toContain("aria-describedby");
		});

		it("shows both problems at once", async () => {
			const html = await (
				await post("/bills", fields({ name: "water", amount: "150000.00" }))
			).text();
			expect(html).toContain("You already have a bill called Water.");
			expect(html).toContain("$150,000.00 is a lot for a bill.");
			expect(html.match(/role="alert"/g)?.length).toBe(2);
		});

		it("has no chip on an ordinary form or a normal amount", async () => {
			const html = await (
				await exports.default.fetch("http://tally.test/bills/new")
			).text();
			expect(confirmChip(html)).toBeUndefined();
			const bad = await (
				await post("/bills", fields({ name: "Gym", due_day: "40" }))
			).text();
			expect(confirmChip(bad)).toBeUndefined();
		});
	});
});

describe("Bills' status headings and inactive bills", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-10T16:00:00Z"));
		await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
		await env.DB.prepare("DELETE FROM bills").run();
		const [paid, earlier] = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE amount_cents > 0 ORDER BY id LIMIT 2",
			).all<{ id: number }>()
		).results;
		await env.DB.batch([
			// Overdue: due Oct 3 and not paid.
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9711,'Why overdue fixture',10000,3,'monthly',5,'WHY OVERDUE FIXTURE')",
			),
			// Due in the next 7 days: Oct 14, not paid.
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9712,'Why due fixture',10000,14,'monthly',5,'WHY DUE FIXTURE')",
			),
			// Upcoming: Oct 25, with September paid.
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9713,'Why upcoming fixture',10000,25,'monthly',5,'WHY UPCOMING FIXTURE')",
			),
			// Paid this month: Oct 3 is paid.
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9714,'Why paid fixture',10000,3,'monthly',5,'WHY PAID FIXTURE')",
			),
			// Inactive: shows its schedule, not a due date.
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name,active) VALUES(9715,'Old phone plan',4500,15,'monthly',5,'OLD PHONE PLAN FIXTURE',0)",
			),
		]);
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9713,'2026-09',?,'user','linked')",
		)
			.bind(earlier?.id ?? 0)
			.run();
		await env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(9714,'2026-10',?,'user','linked')",
		)
			.bind(paid?.id ?? 0)
			.run();
	});
	afterEach(() => vi.useRealTimers());

	it.each([
		["Overdue", "overdue"],
		["Due in the next 7 days", "due in the next 7 days"],
		["Upcoming", "upcoming"],
		["Paid this month", "paid this month"],
	])(
		"gives the %s heading a Why? to the Bills section of How Tally works, beside it and not inside it",
		async (heading, topic) => {
			const html = await (
				await exports.default.fetch("http://tally.test/bills")
			).text();
			const group = groupUnder(html, heading);
			expect(group).toContain(`aria-label="Why? ${topic}"`);
			expect(group).toMatch(
				new RegExp(
					`>${heading}</h2><span aria-hidden="true">·</span><a href="/how-it-works#bills" aria-label="Why\\? ${topic}"`,
				),
			);
		},
	);

	it("shows an inactive bill's schedule under Inactive, in place of a due date", async () => {
		const html = await (
			await exports.default.fetch("http://tally.test/bills")
		).text();
		const row =
			html.split("<li").find((item) => item.includes(">Old phone plan<")) ?? "";
		expect(row).toContain("Monthly, on the 15th");
		expect(row).not.toContain("Due ");
	});
});
