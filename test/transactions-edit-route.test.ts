import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { JEV_THRESHOLD } from "../src/ai/categorize";
import { categorizePending } from "../src/categorize-pending";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

const BASE = "http://tally.test";
const rowCount = (html: string) =>
	(html.match(/<li data-transaction=/g) ?? []).length;

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(path: string, fields: Record<string, string>, htmx = true) {
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: new URLSearchParams(fields).toString(),
	});
	return { res, html: await res.text() };
}

let bakery: number;
beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	bakery = (
		await env.DB.prepare(
			"SELECT id FROM transactions WHERE raw_name = 'SQ *LOCAL BAKERY 4432'",
		).first<{ id: number }>()
	)?.id as number;
});

describe("row links", () => {
	it("open the edit sheet for that row, keeping the list's filters", async () => {
		const { html } = await get("/transactions?uncategorized=1");
		expect(html).toMatch(
			new RegExp(
				`<a href="/transactions/${bakery}\\?uncategorized=1"[^>]*hx-target="#sheet"`,
			),
		);
	});
});

describe("GET /transactions/:id", () => {
	it("offers both unsure category and income answers in the edit panel", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings(key,value) VALUES('ai_income','on') ON CONFLICT(key) DO UPDATE SET value='on'",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-2500, credit_reviewed=0, jev_category_id=1, category_confidence=0.5, income_confidence=0.5 WHERE id=?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toMatch(
			/name="category" value="1"[^>]*aria-describedby="category-suggestion-confidence-\d+-1"[^>]*class="sr-only"\/>Groceries <span class="text-muted">· Suggested<\/span>/,
		);
		expect(sheet).toMatch(
			new RegExp(
				`<input type="checkbox" name="income" value="1"[^>]*aria-describedby="income-suggestion-confidence-${bakery}"`,
			),
		);
		expect(sheet).toContain(
			`id="income-suggestion-confidence-${bakery}" class="flex flex-wrap items-center gap-x-2 text-sm text-muted">Tally&#39;s guess · 50% sure`,
		);
	});

	it("links the income guess text to its checkbox with a transaction-specific id", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings(key,value) VALUES('ai_income','on') ON CONFLICT(key) DO UPDATE SET value='on'",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-2500, credit_reviewed=0, income_confidence=0.5 WHERE id=?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		const describedBy = html.match(
			/<input type="checkbox" name="income" value="1"[^>]*aria-describedby="([^"]+)"/,
		)?.[1];
		expect(describedBy).toBe(`income-suggestion-confidence-${bakery}`);
		expect(html).toMatch(
			new RegExp(
				`<p[^>]*id="${describedBy}"[^>]*>Tally&#39;s guess · 50% sure`,
			),
		);
	});

	it("keeps an excluded transfer ahead of the income suggestion in the edit panel", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings(key,value) VALUES('ai_income','on') ON CONFLICT(key) DO UPDATE SET value='on'",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-2500, excluded=1, credit_reviewed=0, income_confidence=0.5 WHERE id=?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toContain("Exclude from budget");
		expect(sheet).not.toContain("Tally&#39;s guess · 50% sure");
		expect(sheet).not.toContain('id="income-suggestion-confidence-');
	});

	it("drops the income guess style when the posted choice is checked on a validation error", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings(key,value) VALUES('ai_income','on') ON CONFLICT(key) DO UPDATE SET value='on'",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-2500, credit_reviewed=0, income_confidence=0.5 WHERE id=?",
		)
			.bind(bakery)
			.run();
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "invalid",
			income: "1",
			creditReviewedVisible: "1",
			creditReviewed: "0",
		});
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toMatch(
			/<input type="checkbox" name="income" value="1" checked/,
		);
		expect(sheet).not.toContain("Tally&#39;s guess · 50% sure");
		const incomeLabel = sheet.match(
			/<label class="([^"]+)"[^>]*><input type="checkbox" name="income"/,
		);
		expect(incomeLabel?.[1]).not.toContain("border-dashed");
	});

	it("drops the income guess when a stored income choice is unchecked on a validation error", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings(key,value) VALUES('ai_income','on') ON CONFLICT(key) DO UPDATE SET value='on'",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-2500, flag_income=1, income_source='user', credit_reviewed=1, credit_reviewed_by='user', income_confidence=0.5 WHERE id=?",
		)
			.bind(bakery)
			.run();
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "invalid",
			creditReviewedVisible: "1",
			creditReviewed: "0",
		});
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).not.toContain("Tally&#39;s guess · 50% sure");
		expect(sheet).not.toContain('id="income-suggestion-confidence-');
	});

	it("keeps the income guess when an unrelated field errors and income is untouched", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings(key,value) VALUES('ai_income','on') ON CONFLICT(key) DO UPDATE SET value='on'",
		).run();
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-2500, credit_reviewed=0, income_confidence=0.5 WHERE id=?",
		)
			.bind(bakery)
			.run();
		const { html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			category: "invalid",
			creditReviewedVisible: "1",
			creditReviewed: "0",
		});
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toContain("Tally&#39;s guess · 50% sure");
		const incomeLabel = sheet.match(
			/<label class="([^"]+)"[^>]*><input type="checkbox" name="income"/,
		);
		expect(incomeLabel?.[1]).toContain("border-dashed");
	});

	it("renders a confident 0.8 income answer as applied, without Maybe income", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents=-2500, credit_reviewed=1, flag_income=1, income_confidence=NULL, jev_category_id=NULL, category_confidence=NULL WHERE id=?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toContain("Count as income");
		expect(html).not.toContain("Maybe income");
		expect(html).not.toContain(`id="income-suggestion-confidence-${bakery}"`);
	});
	it("shows a below-threshold paycheck guess in the list and edit panel, held out of spending", async () => {
		const id = Number(
			(
				await env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name,credit_reviewed) VALUES (1,'2026-09-14',-71000,'PAYROLL CREDIT',0) RETURNING id",
				).first<{ id: number }>()
			)?.id,
		);
		await categorizePending({ DB: env.DB, JEV_API_KEY: "jev" }, async () =>
			Response.json({
				answers: {
					category: {
						type: "choice",
						choice: "None of these fit",
						confidence: 0.5,
					},
					transfer: { type: "noul", noul: 0.1 },
					reimbursement: { type: "noul", noul: 0.1 },
					income: { type: "noul", noul: 0.71 },
				},
			}),
		);
		const saved = await env.DB.prepare(
			"SELECT flag_income, income_confidence, credit_reviewed FROM transactions WHERE id=?",
		)
			.bind(id)
			.first();
		expect(saved).toEqual({
			flag_income: 0,
			income_confidence: 0.71,
			credit_reviewed: 0,
		});
		const { html: list } = await get(
			"/transactions?show=all&month=all&q=PAYROLL",
		);
		const row = list.slice(list.indexOf(`data-transaction="${id}"`));
		expect(row.slice(0, row.indexOf("</li>"))).toContain("Maybe income");
		expect(row.slice(0, row.indexOf("</li>"))).not.toContain("Review credit");
		const { html: spending } = await get(
			"/transactions?show=spending&month=all&q=PAYROLL",
		);
		expect(spending).not.toContain(`data-transaction="${id}"`);
		const { html: panel } = await get(`/transactions/${id}`);
		const sheet = panel.slice(panel.indexOf('role="dialog"'));
		expect(sheet).toMatch(
			/<fieldset class="flex flex-col gap-2"[^>]*><legend class="[^"]*">Category<\/legend><div class="flex flex-wrap items-start gap-2">/,
		);
		expect(sheet).toContain("Count as income");
		expect(sheet).toContain("border-dashed");
		expect(sheet).toContain("Tally&#39;s guess · 71% sure");
		expect(sheet).toContain('aria-label="Why? income"');
		expect(sheet).toMatch(
			/<p id="income-suggestion-confidence-\d+" class="flex flex-wrap items-center gap-x-2 text-sm text-muted">Tally&#39;s guess · 71% sure<a href="\/how-it-works#categorization" aria-label="Why\? income" class="inline-flex min-h-11 min-w-11/,
		);
		const savedAsRefund = await post(`/transactions/${id}`, {
			merchant: "PAYROLL CREDIT",
			note: "",
			back: "/transactions",
			income: "0",
			creditReviewedVisible: "1",
			creditReviewed: "1",
		});
		expect(savedAsRefund.res.status).toBe(200);
		const { html: reviewedList } = await get(
			"/transactions?show=all&month=all&q=PAYROLL",
		);
		const reviewedRow = reviewedList.slice(
			reviewedList.indexOf(`data-transaction="${id}"`),
		);
		expect(reviewedRow.slice(0, reviewedRow.indexOf("</li>"))).not.toContain(
			"Maybe income",
		);
		const { html: reviewedPanel } = await get(`/transactions/${id}`);
		expect(reviewedPanel).not.toContain("Tally&#39;s guess · 71% sure");
	});

	it("keeps the edit-panel income guess consistent with posted choices on validation errors", async () => {
		const id = Number(
			(
				await env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name,credit_reviewed,income_confidence) VALUES (1,'2026-09-14',-71000,'PAYROLL GUESS',0,0.71) RETURNING id",
				).first<{ id: number }>()
			)?.id,
		);
		const panel = async (fields: Record<string, string>) => {
			const { res, html } = await post(`/transactions/${id}`, {
				category: "99",
				merchant: "PAYROLL GUESS",
				note: "",
				back: "/transactions",
				income: "0",
				creditReviewedVisible: "1",
				...fields,
			});
			expect(res.status).toBe(422);
			return html.includes("Tally&#39;s guess · 71% sure");
		};
		const { html: firstRender } = await get(`/transactions/${id}`);
		expect(firstRender).toContain("Tally&#39;s guess · 71% sure");
		expect(await panel({ creditReviewed: "1" })).toBe(false);
		expect(await panel({ income: "1" })).toBe(false);
		expect(await panel({})).toBe(true);

		await env.DB.prepare(
			"UPDATE transactions SET credit_reviewed = 1 WHERE id = ?",
		)
			.bind(id)
			.run();
		expect(await panel({ creditReviewed: "0" })).toBe(false);
	});

	it("hides an income guess when Spot paychecks is off", async () => {
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('ai_income', 'off') ON CONFLICT(key) DO UPDATE SET value = 'off'",
		).run();
		const id = Number(
			(
				await env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name,credit_reviewed) VALUES (1,'2026-09-14',-95000,'OFF PAYCHECK',0) RETURNING id",
				).first<{ id: number }>()
			)?.id,
		);
		await categorizePending({ DB: env.DB, JEV_API_KEY: "jev" }, async () =>
			Response.json({
				answers: {
					category: {
						type: "choice",
						choice: "None of these fit",
						confidence: 0.5,
					},
					transfer: { type: "noul", noul: 0.1 },
					reimbursement: { type: "noul", noul: 0.1 },
					income: { type: "noul", noul: 0.95 },
				},
			}),
		);
		const saved = await env.DB.prepare(
			"SELECT flag_income, income_confidence FROM transactions WHERE id=?",
		)
			.bind(id)
			.first();
		expect(saved).toEqual({ flag_income: 0, income_confidence: null });
		const { html: list } = await get(
			"/transactions?show=all&month=all&q=OFF%20PAYCHECK",
		);
		expect(list).not.toContain("Maybe income");
		const { html: panel } = await get(`/transactions/${id}`);
		expect(panel).not.toContain("Tally&#39;s guess · 95% sure");
	});

	it("shows a below-threshold Jev pick as the first suggested chip after the real save path", async () => {
		const id = Number(
			(
				await env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name) VALUES (1,'2026-09-14',1200,'LOW CONFIDENCE SHOP') RETURNING id",
				).first<{ id: number }>()
			)?.id,
		);
		await categorizePending({ DB: env.DB, JEV_API_KEY: "jev" }, async () =>
			Response.json({
				answers: {
					category: {
						type: "choice",
						choice: "Groceries",
						confidence: JEV_THRESHOLD - 0.01,
					},
					transfer: { type: "noul", noul: 0.01 },
					reimbursement: { type: "noul", noul: 0.01 },
					income: { type: "noul", noul: 0.01 },
				},
			}),
		);
		const saved = await env.DB.prepare(
			"SELECT category_id, category_source, jev_category_id FROM transactions WHERE id=?",
		)
			.bind(id)
			.first<{
				category_id: number | null;
				category_source: string | null;
				jev_category_id: number | null;
			}>();
		expect(saved).toMatchObject({
			category_id: null,
			category_source: null,
			jev_category_id: 1,
		});
		const { html } = await get(`/transactions/${id}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toMatch(
			/<span class="relative inline-flex rounded-full border border-dashed border-ink">[\s\S]*?<input type="radio" name="category" value="1"/,
		);
		expect(sheet.indexOf('value="1"')).toBeLessThan(sheet.indexOf('value="2"'));
		const describedBy = sheet.match(
			/<input type="radio" name="category" value="1"[^>]*aria-describedby="([^"]+)"/,
		)?.[1];
		expect(describedBy).toBeTruthy();
		expect(sheet).toMatch(
			new RegExp(
				`<span class="sr-only" id="${describedBy}">Tally&#39;s guess · 79% sure</span>`,
			),
		);
	});

	it("shows no existing-category chip behind a pending new-category suggestion", async () => {
		const id = Number(
			(
				await env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name) VALUES (1,'2026-09-14',1200,'PENDING NEW CATEGORY') RETURNING id",
				).first<{ id: number }>()
			)?.id,
		);
		const suggestion = await env.DB.prepare(
			"INSERT INTO category_suggestions (name,status) VALUES ('Pet Care','pending') RETURNING id",
		).first<{ id: number }>();
		await env.DB.prepare(
			"UPDATE transactions SET category_suggestion_id=? WHERE id=?",
		)
			.bind(suggestion?.id, id)
			.run();
		const { html: sheetHtml } = await get(`/transactions/${id}`);
		const sheet = sheetHtml.slice(sheetHtml.indexOf('role="dialog"'));
		expect(sheet).not.toContain("Suggested");
		const { html } = await get(
			"/transactions?month=all&q=PENDING%20NEW%20CATEGORY",
		);
		expect(html).toContain("Maybe new: Pet Care");
		expect(html).toContain("PENDING NEW CATEGORY");
	});

	it("hides a below-threshold Jev chip when its category is archived", async () => {
		const id = Number(
			(
				await env.DB.prepare(
					"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,'2026-09-14',1200,'ARCHIVED GUESS') RETURNING id",
				).first<{ id: number }>()
			)?.id,
		);
		await env.DB.prepare(
			"UPDATE transactions SET jev_category_id=1,category_confidence=? WHERE id=?",
		)
			.bind(JEV_THRESHOLD - 0.01, id)
			.run();
		await env.DB.prepare("UPDATE categories SET archived=1 WHERE id=1").run();
		const { html } = await get(`/transactions/${id}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).not.toContain('type="radio" name="category" value="1"');
		expect(sheet).not.toContain("Tally&#39;s guess");
	});

	it("shows the list and the edit sheet, labeled and focused", async () => {
		const { res, html } = await get(`/transactions/${bakery}?uncategorized=1`);
		expect(res.status).toBe(200);
		expect(rowCount(html)).toBe(10);
		expect(html).toMatch(/<section role="dialog" aria-labelledby="edit-title"/);
		expect(html).toMatch(
			/<h2 id="edit-title"[^>]*autofocus[^>]*class="[^"]*\bmin-w-0\b[^"]*\bwrap-anywhere\b[^"]*">Local Bakery<\/h2>/,
		);
		expect(html).toContain("SQ *LOCAL BAKERY 4432");
		expect(html).toContain("$12.00");
		expect(html).toMatch(/Credit card ••9012/);
		expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Category<\/legend>/);
		expect(
			(html.match(/<input type="radio" name="category"/g) ?? []).length,
		).toBe(5);
		expect(html).toContain("Always for this merchant");
		expect(html).toContain("Count as income");
		expect(html).toMatch(/<input[^>]*name="merchant"[^>]*value="Local Bakery"/);
		expect(html).toMatch(/<label for="note"[^>]*>Note<\/label>/);
		expect(html).toMatch(
			/<a href="\/transactions\?uncategorized=1"[^>]*>Cancel<\/a>/,
		);
		expect(html).toMatch(
			/<button type="submit"[^>]*>[\s\S]*?Save[\s\S]*?<\/button>/,
		);
	});

	it("tidies an unnamed merchant's raw text for the heading, showing the raw text underneath and as the input placeholder", async () => {
		const paypal = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'PAYPAL *XYZSHOP'",
			).first<{ id: number }>()
		)?.id;
		const { html } = await get(`/transactions/${paypal}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toMatch(/<h2 id="edit-title"[^>]*>Xyzshop<\/h2>/);
		// The raw text differs from the tidied heading, so it shows underneath and as the placeholder.
		expect(sheet.match(/PAYPAL \*XYZSHOP/g)).toHaveLength(2);
	});

	it("keeps an unbroken merchant name inside the edit-sheet heading", async () => {
		const longName = "x".repeat(48);
		const id = Number(
			(
				await env.DB.prepare(
					"INSERT INTO transactions (account_id,date,amount_cents,raw_name) VALUES (1,'2026-09-14',1200,?) RETURNING id",
				)
					.bind(longName)
					.first<{ id: number }>()
			)?.id,
		);
		const { html } = await get(`/transactions/${id}`);
		const heading = html.match(/<h2 id="edit-title"[^>]*>/)?.[0] ?? "";
		expect(heading).toMatch(/class="[^"]*\bmin-w-0\b[^"]*\bwrap-anywhere\b/);
		expect(html).toContain(`${heading}${longName}</h2>`);
	});

	it("is a 404 page for an unknown id", async () => {
		const { res, html } = await get("/transactions/999999");
		expect(res.status).toBe(404);
		expect(html).toContain('aria-label="Main"');
		// The app's own 404 page (spec §8.5), not a page of this route's own.
		expect(html).toContain("This page isn&#39;t here.");
		expect(html).not.toContain("Back to Transactions");
	});

	it("is that same 404 page for a missing split form and a missing cash delete", async () => {
		const split = await get("/transactions/999999/split");
		expect(split.res.status).toBe(404);
		expect(split.html).toContain("This page isn&#39;t here.");
		const gone = await post(
			"/transactions/999999/delete",
			{ back: "/transactions" },
			false,
		);
		expect(gone.res.status).toBe(404);
		expect(gone.html).toContain("This page isn&#39;t here.");
	});
});

describe("POST /transactions/:id", () => {
	const save = {
		category: "2",
		merchant: "Local Bakery",
		note: "",
		back: "/transactions?uncategorized=1",
		income: "0",
		creditReviewed: "0",
	};

	it("keeps a Jev income credit unchanged on a note-only save", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = 0.95, flag_income = 1, income_source = 'jev', credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const sheet = await get(`/transactions/${bakery}`);
		expect(sheet.html).toContain('name="creditReviewedVisible"');
		expect(sheet.html).toContain('name="creditReviewed"');
		const { res } = await post(`/transactions/${bakery}`, {
			merchant: "Synthetic Payroll",
			note: "Synthetic note",
			back: "/transactions",
			income: "1",
			creditReviewedVisible: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT note, flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toEqual({
			note: "Synthetic note",
			flag_income: 1,
			income_source: "jev",
			credit_reviewed: 1,
			credit_reviewed_by: null,
		});
	});

	it("opens a Jev-settled income credit with income checked and person review unchecked", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, flag_income = 1, income_source = 'jev', credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toMatch(/name="income" value="1" checked/);
		expect(sheet).toMatch(/name="creditReviewed" value="1"(?! checked)/);
	});

	it("unticking Jev income alone leaves the credit unreviewed by a person and held", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, flag_income = 1, income_source = 'jev', credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const { res } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			income: "0",
			creditReviewedVisible: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT flag_income, income_source, credit_reviewed, credit_reviewed_by, excluded FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 0,
			credit_reviewed_by: null,
			excluded: 0,
		});
	});

	it("opens a person-reviewed credit with person review checked", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, flag_income = 0, income_source = NULL, credit_reviewed = 1, credit_reviewed_by = 'user' WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		const sheet = html.slice(html.indexOf('role="dialog"'));
		expect(sheet).toMatch(/name="creditReviewed" value="1" checked/);
	});

	it("lets a person turn Jev income into a reviewed refund in one save", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET amount_cents = -500, category_id = NULL, category_source = NULL, category_confidence = 0.95, flag_income = 1, income_source = 'jev', credit_reviewed = 1, credit_reviewed_by = NULL WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const sheet = await get(`/transactions/${bakery}`);
		expect(sheet.html).toContain('name="creditReviewedVisible"');
		expect(sheet.html).toContain(
			"Reviewed as a refund or other non-income credit",
		);

		const { res } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			income: "0",
			creditReviewedVisible: "1",
			creditReviewed: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT flag_income, income_source, credit_reviewed, credit_reviewed_by FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toEqual({
			flag_income: 0,
			income_source: "user",
			credit_reviewed: 1,
			credit_reviewed_by: "user",
		});
	});

	it("saves, closes the sheet, and confirms with a toast and announcement (htmx)", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, save);
		expect(res.status).toBe(200);
		expect(rowCount(html)).toBe(9);
		expect(html).not.toContain('role="dialog"');
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Saved Local Bakery", type: "success" },
			announce: "Saved. Local Bakery is now Eating Out.",
		});
		expect(res.headers.get("HX-Push-Url")).toBe(
			"/transactions?uncategorized=1",
		);
		// The saved row left this filtered list, so focus goes to the result count.
		expect(html).toMatch(/<p id="result-count"[^>]*autofocus/);
	});

	it("names an unnamed merchant by its tidied text in the toast and announcement, never the raw bank text", async () => {
		const paypal = (
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'PAYPAL *XYZSHOP'",
			).first<{ id: number }>()
		)?.id;
		const { res } = await post(`/transactions/${paypal}`, {
			...save,
			merchant: "",
		});
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Saved Xyzshop", type: "success" },
			announce: "Saved. Xyzshop is now Eating Out.",
		});
	});

	it("updates the Needs category count outside the swapped list after a save", async () => {
		const { html: sheet } = await get(
			`/transactions/${bakery}?uncategorized=1`,
		);
		expect(sheet).toMatch(
			/<form method="post"[^>]*hx-select-oob="#needs-count:innerHTML"/,
		);
		const { html } = await post(`/transactions/${bakery}`, save);
		expect(html).toMatch(/<span id="needs-count">9<\/span>/);
	});

	it("saves a person's income choice and preserves it when Jev runs again", async () => {
		const { res } = await post(`/transactions/${bakery}`, {
			...save,
			income: "1",
		});
		expect(res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT flag_income, income_source FROM transactions WHERE id = ?",
			)
				.bind(bakery)
				.first(),
		).toMatchObject({ flag_income: 1, income_source: "user" });
	});

	it("returns focus to the saved row when it's still in the list", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			...save,
			back: "/transactions",
		});
		expect(html).toMatch(
			new RegExp(`<a href="/transactions/${bakery}"[^>]*autofocus`),
		);
	});

	it("redirects back to the list without JavaScript", async () => {
		const { res } = await post(`/transactions/${bakery}`, save, false);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/transactions?uncategorized=1");
	});

	it("never redirects off the Transactions list", async () => {
		const { res } = await post(
			`/transactions/${bakery}`,
			{ ...save, back: "https://evil.example" },
			false,
		);
		expect(res.headers.get("Location")).toBe("/transactions");
	});

	it("re-renders the sheet with the error and the typed values", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, {
			...save,
			category: "99",
			note: "keep me",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/role="alert"[^>]*>Pick a category from the list\./);
		expect(html).toContain("keep me");
		expect(html).toContain('role="dialog"');
	});

	it("updates Home", async () => {
		await post(`/transactions/${bakery}`, save);
		expect((await get("/")).html).toContain("9 transactions need a category");
	});
});

describe("who picked the category", () => {
	const setSource = (source: string | null, confidence: number | null) =>
		env.DB.prepare(
			"UPDATE transactions SET category_id = 2, category_source = ?, category_confidence = ? WHERE id = ?",
		)
			.bind(source, confidence, bakery)
			.run();

	it("says when Tally picked it, with how sure Tally was", async () => {
		await setSource("jev", 0.934);
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toContain("Picked by Tally · 93% sure");
	});

	it("says nothing for a person's choice or a merchant rule", async () => {
		await setSource("user", null);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Tally",
		);
		await setSource("merchant_rule", null);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Tally",
		);
	});

	it("explains a bill category beside Category, but not a person's choice", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET category_id=5, category_source='bill' WHERE id=?",
		)
			.bind(bakery)
			.run();
		let sheet = (await get(`/transactions/${bakery}`)).html;
		expect(sheet).toMatch(
			/<legend[^>]*>Category[\s\S]*?<a[^>]*href="\/how-it-works#categorization"[^>]*aria-label="Why\? this category"/,
		);

		await setSource("user", null);
		sheet = (await get(`/transactions/${bakery}`)).html;
		expect(sheet).not.toContain('aria-label="Why? this category"');
	});

	it("lets an Always merchant rule replace a bill category without replacing a person's choice", async () => {
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO transactions (id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9800,id,'2026-09-20',1200,'SQ *LOCAL BAKERY 4432',5,'bill' FROM accounts LIMIT 1",
			),
			env.DB.prepare(
				"INSERT INTO transactions (id,account_id,date,amount_cents,raw_name,category_id,category_source) SELECT 9801,id,'2026-09-19',1200,'SQ *LOCAL BAKERY 4432',4,'user' FROM accounts LIMIT 1",
			),
		]);
		await post(`/transactions/${bakery}`, {
			category: "2",
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
			always: "1",
		});
		const rows = await env.DB.prepare(
			"SELECT id,category_id AS categoryId,category_source AS categorySource FROM transactions WHERE id IN (9800,9801) ORDER BY id",
		).all();
		expect(rows.results).toEqual([
			{ id: 9800, categoryId: 2, categorySource: "merchant_rule" },
			{ id: 9801, categoryId: 4, categorySource: "user" },
		]);
	});

	it("goes away once a person chooses the category", async () => {
		await setSource("jev", 0.9);
		const { res } = await post(`/transactions/${bakery}`, {
			category: "1",
			merchant: "Local Bakery",
			note: "",
			back: "/transactions",
		});
		expect(res.status).toBe(200);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Picked by Tally",
		);
	});
});

describe("excluding a transaction (spec §6, #27)", () => {
	const transferId = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'ONLINE TRANSFER TO SAV ...5678' ORDER BY date DESC",
			).first<{ id: number }>()
		)?.id as number;
	// The edit form's box, not anything in the list's filters.
	const checkbox =
		/<form method="post"[\s\S]*<input type="checkbox" name="excluded" value="1"([^>]*)>/;

	it("shows a labeled exclude checkbox that reflects the transaction", async () => {
		const bakerySheet = (await get(`/transactions/${bakery}`)).html;
		expect(bakerySheet).toMatch(checkbox);
		expect(bakerySheet.match(checkbox)?.[1]).not.toContain("checked");
		expect(bakerySheet).toContain("Exclude from budget");
		const transferSheet = (await get(`/transactions/${await transferId()}`))
			.html;
		expect(transferSheet.match(checkbox)?.[1]).toContain("checked");
	});

	it("excludes on save, and says so", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, {
			merchant: "Local Bakery",
			note: "",
			excluded: "1",
			back: "/transactions?uncategorized=1",
		});
		expect(rowCount(html)).toBe(9);
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}").announce).toBe(
			"Saved Local Bakery. It's excluded from the budget.",
		);
		expect((await get("/")).html).toContain("9 transactions need a category");
	});

	it("includes an excluded transaction again when the box is cleared, and says so", async () => {
		const id = await transferId();
		const { res } = await post(`/transactions/${id}`, {
			merchant: "",
			note: "",
			back: "/transactions",
		});
		expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}").announce).toMatch(
			/It counts in the budget again\.$/,
		);
		const row = await env.DB.prepare(
			"SELECT excluded FROM transactions WHERE id = ?",
		)
			.bind(id)
			.first<{ excluded: number }>();
		expect(row?.excluded).toBe(0);
	});

	it("keeps the box as typed when the form has an error", async () => {
		const { html } = await post(`/transactions/${bakery}`, {
			category: "99",
			merchant: "",
			note: "",
			excluded: "1",
			back: "/transactions",
		});
		expect(html.match(checkbox)?.[1]).toContain("checked");
	});
});

describe("the edit panel's layout (owner's pick C, #27)", () => {
	const reimbursement = async () =>
		(
			await env.DB.prepare(
				"SELECT id FROM transactions WHERE raw_name = 'DR MARTIN FAMILY PRACTICE REFUND'",
			).first<{ id: number }>()
		)?.id as number;

	it("keeps renaming and the note behind one closed disclosure", async () => {
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toMatch(
			/<details class="[^"]*group[^"]*">\s*<summary[^>]*>[\s\S]*Rename or add a note/,
		);
		expect(html).not.toMatch(/<details[^>]*\bopen/);
		// The name field is inside the disclosure.
		expect(html.indexOf('name="merchant"')).toBeGreaterThan(
			html.indexOf("Rename or add a note"),
		);
	});

	it("opens the disclosure when there's a note to see", async () => {
		await env.DB.prepare(
			"UPDATE transactions SET note = 'birthday' WHERE id = ?",
		)
			.bind(bakery)
			.run();
		const { html } = await get(`/transactions/${bakery}`);
		expect(html).toMatch(/<details[^>]*\bopen/);
	});

	it("opens the disclosure when a failed save brings back a typed new name", async () => {
		const { res, html } = await post(`/transactions/${bakery}`, {
			category: "99",
			merchant: "Corner Bakery",
			note: "",
			back: "/transactions",
		});
		expect(res.status).toBe(422);
		expect(html).toMatch(/<details[^>]*\bopen/);
		expect(html).toMatch(/name="merchant"[^>]*value="Corner Bakery"/);
	});

	it("says an excluded transaction is excluded, near the top", async () => {
		const excluded = (await get(`/transactions/${await reimbursement()}`)).html;
		expect(excluded).toContain("Excluded from the budget");
		expect(excluded.indexOf("Excluded from the budget")).toBeLessThan(
			excluded.indexOf('<form method="post"'),
		);
		expect((await get(`/transactions/${bakery}`)).html).not.toContain(
			"Excluded from the budget",
		);
	});

	it("says an excluded payment that pays a bill counts, instead of calling it excluded, in the panel and the list (spec §8.5)", async () => {
		const id = await reimbursement();
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO bills(id,name,amount_cents,due_day,frequency,category_id,merchant_raw_name) VALUES(9600,'Venmo',1000,5,'monthly',5,'VENMO')",
			),
			env.DB.prepare(
				"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT 9600, substr(date,1,7), id, 'user', 'linked' FROM transactions WHERE id = ?",
			).bind(id),
		]);
		const panel = (await get(`/transactions/${id}`)).html;
		expect(panel).not.toContain("Excluded from the budget");
		expect(panel).toContain("It pays a bill, so it counts in the budget.");
		// The chip still shows the saved exclusion, so saving a note doesn't change it.
		expect(panel).toMatch(/name="excluded"[^>]*checked/);

		const list = (await get("/transactions?month=all&q=MARTIN")).html;
		expect(list).toContain(`data-transaction="${id}"`);
		const row = list.split(`data-transaction="${id}"`)[1]?.split("</li>")[0];
		expect(row).not.toContain("Excluded");
		const filtered = (await get("/transactions?month=all&excluded=1")).html;
		expect(filtered).not.toContain(`data-transaction="${id}"`);

		// Saving a note leaves the exclusion exactly as it was.
		const saved = await post(`/transactions/${id}`, {
			category: "",
			merchant: "",
			note: "rent",
			excluded: "1",
			back: "/transactions",
		});
		expect(saved.res.status).toBe(200);
		expect(
			await env.DB.prepare(
				"SELECT excluded, excluded_source FROM transactions WHERE id = ?",
			)
				.bind(id)
				.first(),
		).toMatchObject({ excluded: 1 });
	});

	it("has one How this works link", async () => {
		const html = (await get(`/transactions/${bakery}`)).html;
		const sheet = html.slice(html.indexOf('id="edit-title"'));
		expect((sheet.match(/href="\/how-it-works#/g) ?? []).length).toBe(1);
	});
});
