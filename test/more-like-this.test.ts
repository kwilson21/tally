import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sameTextPeers } from "../src/db/more-like-this";
import { resetDemo } from "../src/demo/reset";
import type { SameTextRow } from "../src/same-text-matches";

// "2 more look like this" (decision 157, step A): after "Create and next" files a purchase, the waiting purchases
// with the same cleaned bank text are one card with every row ticked. Nothing moves until Add. The URL carries only
// the filed purchase's id. No Jev and no AI call.

const db = env.DB;
const BASE = "http://tally.test";
const AUDIBLE = "AUDIBLE*TE3E10I7 WA";

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path);
	return { res, html: await res.text() };
}

async function post(
	path: string,
	fields: Record<string, string | string[]>,
	htmx = true,
) {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(fields))
		for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
	const res = await exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: {
			Origin: BASE,
			"content-type": "application/x-www-form-urlencoded",
			...(htmx ? { "HX-Request": "true" } : {}),
		},
		body: body.toString(),
	});
	return { res, html: await res.text() };
}

const trigger = (res: Response) =>
	JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; type: string };
		announce?: string;
	};

/** Every URL the page draws in an attribute: links, forms and HTMX targets. None may carry bank text. */
const urlsIn = (html: string) =>
	[...html.matchAll(/\s(?:href|action|hx-[a-z-]+)="([^"]*)"/g)].map(
		(m) => m[1],
	);

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

async function tx(fields: {
	raw: string;
	amount?: number;
	date?: string;
	note?: string | null;
	noteGuessed?: number;
	confidence?: number | null;
	jevCategoryId?: number | null;
	jevMixed?: number | null;
	jevAlsoCategoryId?: number | null;
	categoryId?: number | null;
	categorySource?: string | null;
}): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, note, note_guessed,
				category_confidence, jev_category_id, jev_mixed, jev_also_category_id, category_id, category_source)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-${crypto.randomUUID()}`,
			fields.date ?? "2026-10-02",
			fields.amount ?? 1499,
			fields.raw,
			fields.note ?? null,
			fields.noteGuessed ?? 0,
			fields.confidence ?? null,
			fields.jevCategoryId ?? null,
			fields.jevMixed ?? null,
			fields.jevAlsoCategoryId ?? null,
			fields.categoryId ?? null,
			fields.categorySource ?? null,
		)
		.first<{ id: number }>();
	return row?.id ?? 0;
}

/** A purchase Jev guessed at, unsure enough to be a Maybe: the card's one to file in a new category. */
async function maybe(raw: string, note: string | null = null) {
	return tx({
		raw,
		confidence: 0.58,
		jevCategoryId: await categoryId("Eating Out"),
		note,
	});
}

/** Create and next: the answer the Maybe card gives, with a new name (decision 156). */
function createBooks(filed: number, htmx = true) {
	return post(
		"/settings/suggestions",
		{
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		},
		htmx,
	);
}

const state = (id: number) =>
	db
		.prepare(
			"SELECT category_id AS categoryId, category_source AS source FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{ categoryId: number | null; source: string | null }>();

/** Every answer record: Add writes none (it isn't an answer to a Maybe). */
const answerCount = async () =>
	(
		await db
			.prepare("SELECT COUNT(*) AS n FROM maybe_answers")
			.first<{ n: number }>()
	)?.n ?? 0;

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
	]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("sameTextPeers: the rows that look like the filed one (pure)", () => {
	const row = (
		id: number,
		rawName: string,
		extra: Partial<SameTextRow> = {},
	): SameTextRow => ({
		id,
		rawName,
		merchantKey: "AUDIBLE",
		mixed: false,
		whatItWasNote: null,
		...extra,
	});

	it("gives the other rows of the filed one's group, in the order given, never the filed row", () => {
		const filed = row(1, AUDIBLE);
		const peers = sameTextPeers(filed, [
			row(3, AUDIBLE),
			row(4, "CHEWY.COM 1"),
			row(5, AUDIBLE),
		]);
		expect(peers.map((r) => r.id)).toEqual([3, 5]);
	});

	it("gives nothing when no other row has the same cleaned text, or the filed row is mixed", () => {
		expect(sameTextPeers(row(1, AUDIBLE), [row(2, "CHEWY.COM 1")])).toEqual([]);
		expect(
			sameTextPeers(row(1, AUDIBLE, { mixed: true }), [row(2, AUDIBLE)]),
		).toEqual([]);
	});
});

describe("after Create and next", () => {
	it("shows the one purchase with the same bank text, pre-ticked: '1 more looks like this'", async () => {
		const filed = await maybe(AUDIBLE);
		const same = await tx({ raw: AUDIBLE, date: "2026-10-05" });

		const { res, html } = await createBooks(filed);

		expect(res.status).toBe(200);
		expect(trigger(res).toast?.message).toContain("Books & audio");
		expect(html).toContain("1 more looks like this");
		expect(html).toMatch(
			new RegExp(`name="ticked" value="${same}"[^>]*checked`),
		);
		expect(html).toMatch(/Add to Books (&amp;|&) audio/);
		// The purchase is still waiting: nothing moves until Add.
		expect(await state(same)).toEqual({ categoryId: null, source: null });
	});

	it("says '2 more look like this' for two", async () => {
		const filed = await maybe(AUDIBLE);
		await tx({ raw: AUDIBLE, date: "2026-10-05" });
		await tx({ raw: AUDIBLE, date: "2026-10-09" });

		const { html } = await createBooks(filed);

		expect(html).toContain("2 more look like this");
	});

	it("does not show a purchase from the same merchant whose bank text is different", async () => {
		const filed = await maybe(AUDIBLE);
		await tx({ raw: "AUDIBLE SUBSCRIPTION", date: "2026-10-05" });

		const { res, html } = await createBooks(filed);

		expect(res.status).toBe(200);
		expect(html).not.toContain("like this");
	});

	it("does not show a purchase on a trip Jev calls mixed", async () => {
		const filed = await maybe(AUDIBLE);
		await tx({
			raw: AUDIBLE,
			date: "2026-10-05",
			confidence: 0.58,
			jevCategoryId: await categoryId("Eating Out"),
			jevMixed: 0.9,
			jevAlsoCategoryId: await categoryId("Groceries"),
		});

		const { html } = await createBooks(filed);

		expect(html).not.toContain("like this");
	});

	it("groups APPLE.COM/BILL only with the same note, never with a row without one", async () => {
		const filedNoNote = await maybe("APPLE.COM/BILL", "iCloud");
		await tx({ raw: "APPLE.COM/BILL", date: "2026-10-05" });
		const { html: without } = await createBooks(filedNoNote);
		expect(without).not.toContain("like this");

		const filed = await maybe("APPLE.COM/BILL", "iCloud");
		const same = await tx({
			raw: "APPLE.COM/BILL",
			date: "2026-10-06",
			note: "  ICLOUD ",
		});
		const { html } = await createBooks(filed);
		expect(html).toContain("1 more looks like this");
		expect(html).toMatch(
			new RegExp(`name="ticked" value="${same}"[^>]*checked`),
		);
	});

	it("draws no card, and no error, when nothing else has the same text", async () => {
		const filed = await maybe(AUDIBLE);

		const { res, html } = await createBooks(filed);

		expect(res.status).toBe(200);
		expect(html).not.toContain("like this");
		expect(trigger(res).toast?.message).toContain("Books & audio");
	});

	it("without JavaScript, the redirect carries only the filed purchase's id, and the page shows the card", async () => {
		const filed = await maybe(AUDIBLE);
		const same = await tx({ raw: AUDIBLE, date: "2026-10-05" });

		const { res } = await createBooks(filed, false);
		const location = res.headers.get("location") ?? "";
		expect(res.status).toBe(303);
		expect(location).toBe(`/settings/suggestions?more=${filed}`);

		const { html } = await get(location);
		expect(html).toContain("1 more looks like this");
		expect(html).toMatch(
			new RegExp(`name="ticked" value="${same}"[^>]*checked`),
		);
	});

	it("never puts bank text, merchant names or the cleaned text in any URL", async () => {
		const filed = await maybe(AUDIBLE);
		await tx({ raw: AUDIBLE, date: "2026-10-05" });

		const { html } = await createBooks(filed);
		const page = await get(`/settings/suggestions?more=${filed}`);

		const urls = [...urlsIn(html), ...urlsIn(page.html)];
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) expect(url).not.toMatch(/audible/i);
	});

	it("ignores a more id that is not a purchase filed in a category, with no card and no error", async () => {
		const waiting = await tx({ raw: AUDIBLE, date: "2026-10-05" });
		await tx({ raw: AUDIBLE, date: "2026-10-06" });

		for (const more of [String(waiting), "999999", "abc", "-1"]) {
			const { res, html } = await get(`/settings/suggestions?more=${more}`);
			expect(res.status).toBe(200);
			expect(html).not.toContain("like this");
		}
	});

	it("never calls Jev or Workers AI", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const filed = await maybe(AUDIBLE);
		await tx({ raw: AUDIBLE, date: "2026-10-05" });

		const { html } = await createBooks(filed);
		await get(`/settings/suggestions?more=${filed}`);
		await post("/settings/suggestions", { answer: "more_skip" });

		expect(html).toContain("like this");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("a card drawn before the purchase changed moves nothing (Codex P2)", () => {
	it("the card names its category by id, in a hidden field", async () => {
		const filed = await maybe(AUDIBLE);
		await tx({ raw: AUDIBLE, date: "2026-10-05" });
		const { html } = await createBooks(filed);
		const books = await categoryId("Books & audio");
		expect(html).toMatch(new RegExp(`name="category" value="${books}"`));
	});

	it("refuses Add when the filed purchase was recategorized after the card was drawn, moves nothing, and says so", async () => {
		const filed = await maybe(AUDIBLE);
		const peer = await tx({ raw: AUDIBLE, date: "2026-10-05" });
		await createBooks(filed);
		// Another tab files the purchase in a different category.
		await db
			.prepare("UPDATE transactions SET category_id = ? WHERE id = ?")
			.bind(await categoryId("Groceries"), filed)
			.run();

		const { res } = await post(
			"/settings/suggestions",
			{
				answer: "more_add",
				category: String(await categoryId("Books & audio")),
				more: String(filed),
				ticked: String(peer),
			},
			true,
		);

		expect(res.status).toBe(200);
		expect(await state(peer)).toEqual({ categoryId: null, source: null });
		expect(trigger(res).toast?.message).toBe(
			"That purchase was changed somewhere else, so nothing moved.",
		);
	});

	it("refuses Add, moving nothing, when the card's category was archived after the card was drawn", async () => {
		const filed = await maybe(AUDIBLE);
		const peer = await tx({ raw: AUDIBLE, date: "2026-10-05" });
		await createBooks(filed);
		const books = await categoryId("Books & audio");
		await db
			.prepare("UPDATE categories SET archived = 1 WHERE id = ?")
			.bind(books)
			.run();

		const { res } = await post(
			"/settings/suggestions",
			{
				answer: "more_add",
				more: String(filed),
				category: String(books),
				ticked: String(peer),
			},
			true,
		);

		expect(res.status).toBe(200);
		expect(await state(peer)).toEqual({ categoryId: null, source: null });
	});
});

describe("the follow-up card is the whole screen (Codex P2)", () => {
	/** A purchase in the review queue too: a Maybe with its own guess, the same bank text as the filed one. */
	async function peerMaybe() {
		return tx({
			raw: AUDIBLE,
			date: "2026-10-05",
			confidence: 0.58,
			jevCategoryId: await categoryId("Eating Out"),
		});
	}

	it("with a peer that also has a Maybe guess, shows the card and no queue card below it", async () => {
		const filed = await maybe(AUDIBLE);
		await peerMaybe();

		const { html } = await createBooks(filed);

		expect(html).toContain("1 more looks like this");
		expect(html).not.toMatch(/Suggestions · \d+ of \d+/);
		expect(html).not.toMatch(/name="answer" value="yes"/);
	});

	it("after No, the queue's card shows again, and the peer is offered only there", async () => {
		const filed = await maybe(AUDIBLE);
		await peerMaybe();
		await createBooks(filed);

		const { html } = await post(
			"/settings/suggestions",
			{ answer: "more_skip", more: String(filed) },
			true,
		);

		expect(html).not.toContain("more-title");
		expect(html).toMatch(/Suggestions · 1 of 1/);
		expect(html).toMatch(/name="answer" value="yes"/);
	});

	it("after Add, the queue's card shows again, without the peer that was added", async () => {
		const filed = await maybe(AUDIBLE);
		const peer = await peerMaybe();
		const other = await maybe("CHEWY.COM 1");
		await createBooks(filed);

		const { html } = await post(
			"/settings/suggestions",
			{
				answer: "more_add",
				category: String(await categoryId("Books & audio")),
				more: String(filed),
				ticked: String(peer),
			},
			true,
		);

		expect(await state(peer)).toEqual({
			categoryId: await categoryId("Books & audio"),
			source: "user",
		});
		expect(html).not.toContain("more-title");
		expect(html).toMatch(/Suggestions · 1 of 1/);
		expect(html).not.toContain(`value="category-${peer}"`);
		expect(other).toBeGreaterThan(0);
	});
});

describe("Add files only the ticked purchases", () => {
	it("moves the ticked ones into the category, leaves the unticked one, skips one decided meanwhile, and writes no answer", async () => {
		const filed = await maybe(AUDIBLE);
		const ticked = await tx({ raw: AUDIBLE, date: "2026-10-05" });
		const unticked = await tx({ raw: AUDIBLE, date: "2026-10-06" });
		const decided = await tx({ raw: AUDIBLE, date: "2026-10-07" });
		await createBooks(filed);
		const answersBefore = await answerCount();
		// Someone else files the third purchase after the card was drawn.
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(await categoryId("Eating Out"), decided)
			.run();

		const { res, html } = await post(
			"/settings/suggestions",
			{
				answer: "more_add",
				category: String(await categoryId("Books & audio")),
				more: String(filed),
				ticked: [String(ticked), String(decided)],
			},
			true,
		);

		const books = await categoryId("Books & audio");
		expect(res.status).toBe(200);
		expect(await state(ticked)).toEqual({ categoryId: books, source: "user" });
		expect(await state(unticked)).toEqual({ categoryId: null, source: null });
		expect(await state(decided)).toEqual({
			categoryId: await categoryId("Eating Out"),
			source: "user",
		});
		expect(trigger(res).toast?.message).toContain("Moved 1 to Books & audio.");
		expect(trigger(res).toast?.message).toContain(
			"1 was changed somewhere else",
		);
		expect(html).not.toContain("like this");
		expect(await answerCount()).toBe(answersBefore);
	});

	it("moves nothing, and says so, when every ticked purchase was decided meanwhile", async () => {
		const filed = await maybe(AUDIBLE);
		const only = await tx({ raw: AUDIBLE, date: "2026-10-05" });
		await createBooks(filed);
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(await categoryId("Eating Out"), only)
			.run();

		const { res } = await post(
			"/settings/suggestions",
			{
				answer: "more_add",
				more: String(filed),
				category: String(await categoryId("Books & audio")),
				ticked: String(only),
			},
			true,
		);

		expect(res.status).toBe(200);
		expect(trigger(res).toast?.message).toContain("Nothing moved.");
	});

	it("ignores ticked ids that are not in the group, and moves nothing for them", async () => {
		const filed = await maybe(AUDIBLE);
		await tx({ raw: AUDIBLE, date: "2026-10-05" });
		const stranger = await tx({ raw: "CHEWY.COM 1", date: "2026-10-05" });
		await createBooks(filed);

		await post(
			"/settings/suggestions",
			{
				answer: "more_add",
				more: String(filed),
				category: String(await categoryId("Books & audio")),
				ticked: String(stranger),
			},
			true,
		);

		expect(await state(stranger)).toEqual({ categoryId: null, source: null });
	});

	it("No moves on with no change and no record, and never makes a Never-suggest line", async () => {
		const filed = await maybe(AUDIBLE);
		const same = await tx({ raw: AUDIBLE, date: "2026-10-05" });
		await createBooks(filed);

		const { res, html } = await post(
			"/settings/suggestions",
			{ answer: "more_skip", more: String(filed) },
			true,
		);

		expect(res.status).toBe(200);
		expect(html).not.toContain("like this");
		expect(await state(same)).toEqual({ categoryId: null, source: null });
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM never_suggest_rules")
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});
});
