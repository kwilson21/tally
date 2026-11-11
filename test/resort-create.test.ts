import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { moreLikeThis } from "../src/db/more-like-this";
import { finishRun, readMoved, readRun } from "../src/db/resort-run";
import { startResortFor } from "../src/db/resort-start";
import { resetDemo } from "../src/demo/reset";
import { recordSorting } from "./record-sorting";

// Issue #821 (decisions 157, 159, 160): a Create that makes a category starts one background re-check of the rows it
// could now belong to, shows "Tally is re-checking… N done" until it ends, and closes with a toast whose Undo puts back
// only the rows the run moved. These tests drive the four Create paths, the progress poll and Undo through the app.

const db = env.DB;
const BASE = "http://tally.test";
const LUPITA = "SQ *LUPITAS TAQ 2210";
const PLAID_FOOD = "FOOD_AND_DRINK";
const create = recordSorting();

type Env = { JEV_API_KEY?: string };

const mutableEnv = env as unknown as Env;

async function get(path: string) {
	const res = await exports.default.fetch(BASE + path, {
		headers: { Origin: BASE },
	});

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
		toast?: {
			message: string;
			type?: string;
			undo?: string;
			undoExpiresInMs?: number;
			undoAction?: string;
			undoDone?: string;
			passive?: boolean;
			undoTarget?: string;
		};
		announce?: string;
	};

async function categoryId(name: string) {
	const row = await db
		.prepare("SELECT id FROM categories WHERE name = ?")
		.bind(name)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

let seq = 0;

/** One purchase money out that waits for a category, with its Plaid category and Jev's guess. */
async function addRow(
	fields: {
		raw?: string;
		amount?: number;
		jevCategoryId?: number | null;
		confidence?: number | null;
		plaid?: string | null;
		suggestionId?: number | null;
		categoryId?: number | null;
		source?: string | null;
	} = {},
): Promise<number> {
	seq += 1;

	const row = await db
		.prepare(
			`INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name, plaid_category,
				category_confidence, jev_category_id, category_suggestion_id, category_id, category_source)
			VALUES (?, (SELECT id FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1), '2026-10-02', ?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING id`,
		)
		.bind(
			`plaid-resort-${seq}-${crypto.randomUUID()}`,
			fields.amount ?? 2300,
			fields.raw ?? `RESORT ROW ${seq}`,
			fields.plaid === undefined ? PLAID_FOOD : fields.plaid,
			fields.confidence === undefined ? 0.5 : fields.confidence,
			fields.jevCategoryId ?? null,
			fields.suggestionId ?? null,
			fields.categoryId ?? null,
			fields.source ?? null,
		)
		.first<{ id: number }>();

	return Number(row?.id);
}

const rowOf = (id: number) =>
	db
		.prepare(
			"SELECT category_id AS categoryId, category_source AS source, category_confidence AS confidence FROM transactions WHERE id = ?",
		)
		.bind(id)
		.first<{
			categoryId: number | null;
			source: string | null;
			confidence: number | null;
		}>();

/** The run's id from the start request's create call (the instance's reask params). */
const reaskOf = (call: number) => {
	const input = create.mock.calls[call]?.[0] as
		| { params: { reask?: { runId: string; ids: number[] } } }
		| undefined;

	return input?.params.reask;
};

/** Jev's category guess row, filed by a Maybe card, plus related waiting rows that share its Plaid category. */
async function maybeFixture() {
	const eating = await categoryId("Eating Out");

	const filed = await addRow({
		raw: LUPITA,
		jevCategoryId: eating,
		confidence: 0.5,
	});

	const related = [
		await addRow({ raw: "BOOKSHOP 1", amount: 1500, jevCategoryId: eating }),
		await addRow({ raw: "BOOKSHOP 2", amount: 1800, jevCategoryId: eating }),
	];

	return { filed, related, eating };
}

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM transactions"),
		db.prepare("DELETE FROM merchant_suggested_names"),
		db.prepare("DELETE FROM merchants"),
		db.prepare("DELETE FROM category_suggestions"),
		db.prepare(
			"DELETE FROM household_settings WHERE key = 'resort_run' OR key LIKE 'resort_moved_%'",
		),
	]);
	await saveAiSwitches(db, { categories: true });
	mutableEnv.JEV_API_KEY = "test-key";
});

afterEach(() => {
	delete mutableEnv.JEV_API_KEY;
});

describe("starting the re-check from a Maybe card's Create (decision 157)", () => {
	it("starts one run over the related rows and draws the progress line on the page it lands on", async () => {
		const { filed, related } = await maybeFixture();

		const { res, html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});

		expect(res.status).toBe(200);
		expect(create).toHaveBeenCalledTimes(1);
		const reask = reaskOf(0);
		// The run holds the rows in run order (newest first), so the set is what matters.
		expect([...(reask?.ids ?? [])].sort()).toEqual([...related].sort());
		const run = await readRun(db);
		expect(run?.id).toBe(reask?.runId);
		expect(run?.status).toBe("running");
		expect(html).toContain('id="recheck"');
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain(
			`hx-get="/resort/progress?run=${run?.id}&amp;m=0&amp;p=suggestions"`,
		);
		expect(html).toContain('hx-trigger="every 2s"');
		expect(trigger(res).announce).toContain(
			"Tally is re-checking related rows.",
		);
	});

	it("does nothing without a Jev key: no run, no line, and the Create still files the purchase", async () => {
		const { filed } = await maybeFixture();
		delete mutableEnv.JEV_API_KEY;

		const { res, html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});

		expect(res.status).toBe(200);
		expect(create).not.toHaveBeenCalled();
		expect(await readRun(db)).toBeNull();
		expect(html).not.toContain("/resort/progress");
		expect(html).not.toContain('id="recheck"');

		const made = await db
			.prepare("SELECT category_id AS id FROM transactions WHERE id = ?")
			.bind(filed)
			.first<{ id: number }>();

		expect(made?.id).not.toBeNull();
	});

	it("does nothing while the categories switch is off", async () => {
		const { filed } = await maybeFixture();
		await saveAiSwitches(db, { categories: false });

		const { html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});

		expect(create).not.toHaveBeenCalled();
		expect(await readRun(db)).toBeNull();
		expect(html).not.toContain("/resort/progress");
	});

	it("starts nothing when no related row waits, and draws no line", async () => {
		const eating = await categoryId("Eating Out");

		const filed = await addRow({
			raw: LUPITA,
			jevCategoryId: eating,
			plaid: null,
		});

		const { res, html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});

		expect(res.status).toBe(200);
		expect(create).not.toHaveBeenCalled();
		expect(await readRun(db)).toBeNull();
		expect(html).not.toContain("/resort/progress");
		expect(trigger(res).announce).not.toContain("re-checking");
	});

	it("does not start for Add to an existing category, which the person chose (no AI)", async () => {
		const { filed } = await maybeFixture();
		const groceries = await categoryId("Groceries");

		const { html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "else",
			category: String(groceries),
		});

		expect(create).not.toHaveBeenCalled();
		expect(await readRun(db)).toBeNull();
		expect(html).not.toContain("/resort/progress");
	});

	it("never re-checks a row the left-out path already asks (the rows it names are excluded)", async () => {
		const { filed, related, eating } = await maybeFixture();
		// The filed row is in its category, as a Create leaves it, before the run is started.
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(eating, filed)
			.run();
		await startResortFor(mutableEnv as never, db, {
			filedId: filed,
			excludeIds: [related[0] as number],
			now: Date.now(),
		});
		expect(reaskOf(0)?.ids).toEqual([related[1]]);
	});

	it("a second Create while the run goes joins it: one run, only the new rows, one more instance", async () => {
		const eating = await categoryId("Eating Out");
		const first = await maybeFixture();
		await post("/settings/suggestions", {
			id: `category-${first.filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const run = await readRun(db);

		const late = await addRow({
			raw: "BOOKSHOP 3",
			amount: 1900,
			jevCategoryId: eating,
			plaid: null,
		});

		const second = await addRow({ raw: `${LUPITA} 2`, jevCategoryId: eating });

		const { res } = await post("/settings/suggestions", {
			id: `category-${second}`,
			answer: "create",
			new_name: "Gifts",
		});

		expect(res.status).toBe(200);
		expect(create).toHaveBeenCalledTimes(2);
		expect(reaskOf(1)?.runId).toBe(run?.id);
		expect(reaskOf(1)?.ids).toEqual([late]);
		const after = await readRun(db);
		expect(after?.id).toBe(run?.id);
		expect(after?.instances).toBe(2);
	});

	it("a join with nothing new still shows the line and starts no instance", async () => {
		const eating = await categoryId("Eating Out");
		const { filed } = await maybeFixture();
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const run = await readRun(db);
		const again = await addRow({ raw: `${LUPITA} 3`, jevCategoryId: eating });

		// Every related row is already in the run, so the second Create adds none.
		const { res, html } = await post("/settings/suggestions", {
			id: `category-${again}`,
			answer: "create",
			new_name: "Gifts",
		});

		expect(res.status).toBe(200);
		expect(create).toHaveBeenCalledTimes(1);
		expect((await readRun(db))?.id).toBe(run?.id);
		expect(html).toContain(
			`hx-get="/resort/progress?run=${run?.id}&amp;m=0&amp;p=suggestions"`,
		);
	});

	it("a failed start never leaves the line stuck: the run finishes at once, with its own fresh instance key", async () => {
		const { filed } = await maybeFixture();
		create.mockRejectedValueOnce(new Error("no instance"));

		const { html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});

		expect(create).toHaveBeenCalledTimes(1);
		const run = await readRun(db);
		expect(run?.status).toBe("done");
		expect(html).not.toContain("/resort/progress");
	});
});

describe("the progress poll (decision 159)", () => {
	it("returns the sentence with the count while the run goes, clamped to the total, and polls again", async () => {
		const { filed } = await maybeFixture();
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const run = await readRun(db);
		const { res, html } = await get(`/resort/progress?run=${run?.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(html).toContain('id="recheck-line"');
		expect(html).toContain("Tally is re-checking… ");
		expect(html).toContain('hx-trigger="every 2s"');
		expect(html).toContain("data-quiet");
		expect(res.headers.get("HX-Trigger")).toBeNull();
		await db
			.prepare(
				"UPDATE household_settings SET value = json_set(value, '$.done', 99) WHERE key = 'resort_run'",
			)
			.run();
		const clamped = await (await get(`/resort/progress?run=${run?.id}`)).html;
		expect(clamped).toContain(`>${run?.total}</span>`);
	});

	it("the poll that finds the run finished is empty with no polling, and claims the closing toast once", async () => {
		const { filed, related } = await maybeFixture();
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const run = await readRun(db);
		// Jev files one related row into the category (as an instance does), then the run finishes.
		const { eating } = { eating: await categoryId("Eating Out") };
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = NULL WHERE id = ?",
			)
			.bind(eating, related[0])
			.run();
		await finishRun(db, { runId: run?.id ?? "", now: Date.now() });

		const first = await get(`/resort/progress?run=${run?.id}`);
		expect(first.html).not.toContain("hx-trigger");
		expect(first.html).not.toContain("/resort/progress");
		const toast = trigger(first.res).toast;
		expect(toast?.message).toBe("Moved 1 to Eating Out. 1 needs your answer.");
		expect(toast?.type).toBe("success");
		expect(toast?.undo).toBe(run?.id);
		expect(toast?.undoAction).toBe("/resort/undo");
		expect(toast?.undoExpiresInMs).toBe(10_000);
		// A background poll never takes focus (#821 owner feedback): the toast is passive.
		expect(toast?.passive).toBe(true);
		expect(trigger(first.res).announce).toBe(
			"Moved 1 to Eating Out. 1 needs your answer.",
		);

		const second = await get(`/resort/progress?run=${run?.id}`);
		expect(second.res.headers.get("HX-Trigger")).toBeNull();
		expect(second.html).toBe("");
	});

	it("an old run's poll still delivers its toast after a newer run has replaced it", async () => {
		const { filed, related } = await maybeFixture();
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const old = await readRun(db);
		await finishRun(db, { runId: old?.id ?? "", now: Date.now() });

		// A newer run replaces resort_run.
		const newer = await addRow({
			raw: "NEWER ROW",
			jevCategoryId: await categoryId("Eating Out"),
		});

		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?",
			)
			.bind(await categoryId("Groceries"), newer)
			.run();
		await startResortFor(mutableEnv as never, db, {
			filedId: newer,
			excludeIds: [],
			now: Date.now(),
		});
		expect((await readRun(db))?.id).not.toBe(old?.id);
		const { res } = await get(`/resort/progress?run=${old?.id}`);
		// The old run moved nothing, and two of its rows still wait: its own words, with no Undo.
		expect(trigger(res).toast?.message).toBe(
			"Nothing moved. 2 need your answer.",
		);
		expect(trigger(res).toast?.undo).toBeUndefined();
		expect(related.length).toBe(2);
	});

	it("an unknown run id returns the empty fragment with no toast", async () => {
		const { res, html } = await get("/resort/progress?run=no-such-run");
		expect(res.status).toBe(200);
		expect(html).toBe("");
		expect(res.headers.get("HX-Trigger")).toBeNull();
	});

	it("a run that moved nothing and has nothing waiting says so once in the announcer, with no toast", async () => {
		const { filed } = await maybeFixture();
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const run = await readRun(db);
		const eating = await categoryId("Eating Out");
		// Both related rows are decided by a person, so nothing moves and nothing waits.
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'user' WHERE category_id IS NULL AND category_source IS NULL AND raw_name LIKE 'BOOKSHOP%'",
			)
			.bind(eating)
			.run();
		await finishRun(db, { runId: run?.id ?? "", now: Date.now() });
		const { res } = await get(`/resort/progress?run=${run?.id}`);
		expect(trigger(res).toast).toBeUndefined();
		expect(trigger(res).announce).toBe("Tally finished re-checking.");
		expect(await readMoved(db, run?.id ?? "")).toMatchObject({ rows: [] });
	});
});

/** A running run of `total` rows, written as the run record holds it (no instance is started). */
async function seedRun(total: number): Promise<string> {
	const id = crypto.randomUUID();

	const run = {
		id,
		total,
		done: 0,
		status: "running",
		instances: 1,
		ids: [],
		snapshots: [],
		categoryId: await categoryId("Eating Out"),
		categoryName: "Eating Out",
		categories: [],
		categoryByRow: {},
		finishedKeys: [],
		startedAt: Date.now(),
		toasted: false,
	};

	await db
		.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('resort_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(JSON.stringify(run))
		.run();

	return id;
}

const setDone = (done: number) =>
	db
		.prepare(
			"UPDATE household_settings SET value = json_set(value, '$.done', ?) WHERE key = 'resort_run'",
		)
		.bind(done)
		.run();

// The owner's note on #821 (decision 159): the count is read by a screen reader only at milestones. The visible
// sentence shows every count (its number is aria-hidden); a hidden polite region carries the milestone text, which
// changes only when a quarter of the run is crossed. The client holds the milestone it shows in the poll's `m`.
describe("the progress announcements (#821 owner feedback)", () => {
	it("speaks the count only at each quarter of the run: three milestone texts for a run of 14, and the sentence shows every count", async () => {
		const runId = await seedRun(14);
		let held = 0; // the milestone the page holds (the poll's m)
		let spoken = ""; // the text the hidden region holds
		const spokenChanges: string[] = [];

		for (let done = 0; done <= 14; done++) {
			await setDone(done);
			const { html } = await get(`/resort/progress?run=${runId}&m=${held}`);
			expect(html).toContain(
				`<span aria-hidden="true" class="tabular-nums">${done}</span>`,
			);
			const nextHeld = Number(/[?&](?:amp;)?m=(\d)/.exec(html)?.[1] ?? held);

			const milestone =
				/<span id="recheck-milestone" hx-swap-oob="innerHTML">([^<]*)<\/span>/.exec(
					html,
				);

			if (milestone) {
				spoken = milestone[1] ?? "";
				spokenChanges.push(spoken);
			} else {
				// Nothing crossed: nothing is sent for the hidden region, so nothing is spoken.
				expect(nextHeld).toBe(held);
			}

			held = nextHeld;
		}

		expect(spokenChanges).toEqual([
			"4 of 14 done.",
			"7 of 14 done.",
			"11 of 14 done.",
		]);
		expect(new Set(spokenChanges).size).toBeLessThanOrEqual(3);
		expect(spoken).toBe("11 of 14 done.");
	});

	it("draws the hidden polite region beside the sentence, and the sentence's count is aria-hidden", async () => {
		const { filed } = await maybeFixture();

		const { html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});

		expect(html).toContain(
			'<span id="recheck-milestone" role="status" aria-live="polite" class="sr-only"></span>',
		);
		expect(html).toContain(
			'<span aria-hidden="true" class="tabular-nums">0</span>',
		);
	});

	/** The hidden region's spoken text in a poll's answer, or null when the answer sends none. */
	const spokenIn = (html: string) =>
		/<span id="recheck-milestone" hx-swap-oob="innerHTML">([^<]*)<\/span>/.exec(
			html,
		)?.[1] ?? null;

	it("speaks the count it has now when a jump crosses a quarter: 0 to 5 of 14 speaks 5, not the quarter's 4", async () => {
		const runId = await seedRun(14);
		const first = await get(`/resort/progress?run=${runId}&m=0`);
		expect(spokenIn(first.html)).toBeNull();
		await setDone(5);
		const jumped = await get(`/resort/progress?run=${runId}&m=0`);
		expect(jumped.html).toContain(
			'<span aria-hidden="true" class="tabular-nums">5</span>',
		);
		expect(spokenIn(jumped.html)).toBe("5 of 14 done.");
		// The poll's next quarter is the one the page now holds.
		expect(jumped.html).toContain("&amp;m=1");
	});

	it("draws the hidden region at page load with the count it has, and a poll does not repeat the same quarter", async () => {
		const runId = await seedRun(14);
		await setDone(5);
		const { html } = await get("/settings/suggestions");
		expect(html).toContain(
			`hx-get="/resort/progress?run=${runId}&amp;m=1&amp;p=suggestions"`,
		);
		expect(html).toContain(
			'<span id="recheck-milestone" role="status" aria-live="polite" class="sr-only">5 of 14 done.</span>',
		);
		// The first poll at the same quarter holds it: nothing is spoken again.
		const same = await get(`/resort/progress?run=${runId}&m=1`);
		expect(spokenIn(same.html)).toBeNull();
		await setDone(6);
		const next = await get(`/resort/progress?run=${runId}&m=1`);
		expect(spokenIn(next.html)).toBeNull();
	});

	it("treats a malformed m as 0: junk answers like m=0 and never resends on every poll", async () => {
		const runId = await seedRun(14);
		await setDone(14);
		const reference = await get(`/resort/progress?run=${runId}&m=0`);
		expect(spokenIn(reference.html)).toBe("14 of 14 done.");

		for (const junk of ["abc", "-1", "99999", "1.5", "", "NaN", "4"]) {
			const { html } = await get(`/resort/progress?run=${runId}&m=${junk}`);
			expect(html).toBe(reference.html);
		}

		// The answer's own m is the quarter it holds, so the next poll sends a valid one and is silent.
		const held = await get(`/resort/progress?run=${runId}&m=3`);
		expect(spokenIn(held.html)).toBeNull();
	});
});

describe("Undo (decision 160)", () => {
	/** A finished run that moved two rows, its toast claimed, so Undo is open. */
	async function movedRun() {
		const { filed, related } = await maybeFixture();
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const run = await readRun(db);
		const eating = await categoryId("Eating Out");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = NULL WHERE id IN (?, ?)",
			)
			.bind(eating, related[0], related[1])
			.run();
		await finishRun(db, { runId: run?.id ?? "", now: Date.now() });
		await get(`/resort/progress?run=${run?.id}`);

		return { runId: run?.id ?? "", related, eating };
	}

	it("puts back only the rows the run moved, and says so", async () => {
		const { runId, related } = await movedRun();

		const { res, html } = await post("/resort/undo", {
			token: runId,
			back: "/settings/suggestions",
		});

		expect(res.status).toBe(200);
		expect(html).toContain('id="suggestions-page"');
		expect(trigger(res).toast?.message).toBe("Put 2 back.");
		expect(trigger(res).toast?.undoDone).toBe(runId);
		expect(trigger(res).announce).toBe("Put 2 back.");

		for (const id of related) expect((await rowOf(id))?.categoryId).toBeNull();
	});

	it("says how many changed since and stayed", async () => {
		const { runId, related } = await movedRun();
		await db
			.prepare(
				"UPDATE transactions SET category_id = NULL, category_source = NULL WHERE id = ?",
			)
			.bind(related[1])
			.run();

		const { res } = await post("/resort/undo", {
			token: runId,
			back: "/settings/suggestions",
		});

		expect(trigger(res).toast?.message).toBe(
			"Put 1 back. 1 changed since, so it stayed.",
		);
	});

	it("is too late once the ten seconds have passed, and a second Undo changes nothing", async () => {
		const { runId, related, eating } = await movedRun();
		await db
			.prepare(
				"UPDATE household_settings SET value = json_set(value, '$.until', 0) WHERE key = ?",
			)
			.bind(`resort_moved_${runId}`)
			.run();

		const late = await post("/resort/undo", {
			token: runId,
			back: "/settings/suggestions",
		});

		expect(trigger(late.res).toast).toMatchObject({
			message: "Too late to undo that.",
			type: "error",
		});

		for (const id of related)
			expect((await rowOf(id))?.categoryId).toBe(eating);
	});

	it("a double Undo puts back once and changes nothing the second time", async () => {
		const { runId } = await movedRun();
		await post("/resort/undo", { token: runId, back: "/settings/suggestions" });

		const again = await post("/resort/undo", {
			token: runId,
			back: "/settings/suggestions",
		});

		expect(trigger(again.res).toast?.message).toBe("Too late to undo that.");
	});

	it("draws the page with the skip state of its back address, as the browser's address has it (#842 review)", async () => {
		const { runId } = await movedRun();

		// A card the person skipped stays set aside after Undo, so its skip link is in the drawn page.
		const other = await addRow({
			raw: "OTHER SKIP ROW",
			jevCategoryId: await categoryId("Eating Out"),
		});

		const skipped = await post("/resort/undo", {
			token: runId,
			back: `/settings/suggestions?skip=category-${other}`,
		});

		expect(skipped.res.status).toBe(200);
		// The card's form posts to the page with the skip it was drawn with, so the skip carries into the drawn page.
		expect(skipped.html).toContain(
			`action="/settings/suggestions?skip=category-${other}"`,
		);
		expect(skipped.html).toContain('id="suggestions-page"');
	});

	it("answers a back address that is not on this site with a redirect, not a page", async () => {
		const { runId } = await movedRun();

		const { res } = await post(
			"/resort/undo",
			{ token: runId, back: "//evil.example/settings/suggestions" },
			false,
		);

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/settings/suggestions");
	});

	it("draws the page named by back, and answers a page it does not know with a redirect", async () => {
		const { runId } = await movedRun();

		const plain = await post(
			"/resort/undo",
			{ token: runId, back: "/elsewhere" },
			false,
		);

		expect(plain.res.status).toBe(303);
		expect(plain.res.headers.get("location")).toBe("/settings/suggestions");

		const drawn = await post("/resort/undo", {
			token: runId,
			back: "/elsewhere",
		});

		expect(drawn.res.status).toBe(200);
		expect(drawn.html).toContain('id="suggestions-page"');
	});
});

describe("the four Create paths", () => {
	it("Settings' categories card Create starts a run for a new category", async () => {
		const eating = await categoryId("Eating Out");

		const suggestion = (
			await db
				.prepare(
					"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
				)
				.first<{ id: number }>()
		)?.id as number;

		const pets = [
			await addRow({
				raw: "CHEWY.COM 1",
				amount: 4500,
				suggestionId: suggestion,
				plaid: PLAID_FOOD,
				jevCategoryId: eating,
			}),
			await addRow({
				raw: "PETSMART 22",
				amount: 3100,
				suggestionId: suggestion,
				plaid: PLAID_FOOD,
				jevCategoryId: eating,
			}),
		];

		const related = await addRow({
			raw: "BOOKSHOP 9",
			amount: 1200,
			jevCategoryId: eating,
		});

		const { res } = await post(`/settings/suggestions/${suggestion}/create`, {
			ids: pets.map(String),
			shown: pets.map(String),
		});

		expect(res.status).toBe(200);
		expect(create).toHaveBeenCalledTimes(1);
		expect(reaskOf(0)?.ids).toEqual([related]);
	});

	it("Organize's card Create starts a run for a new category", async () => {
		const eating = await categoryId("Eating Out");

		const suggestion = (
			await db
				.prepare(
					"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', 'pending') RETURNING id",
				)
				.first<{ id: number }>()
		)?.id as number;

		const pets = [
			await addRow({
				raw: "CHEWY.COM 1",
				amount: 4500,
				suggestionId: suggestion,
				plaid: PLAID_FOOD,
				jevCategoryId: eating,
			}),
			await addRow({
				raw: "CHEWY.COM 2",
				amount: 3100,
				suggestionId: suggestion,
				plaid: PLAID_FOOD,
				jevCategoryId: eating,
			}),
		];

		const related = await addRow({
			raw: "BOOKSHOP 9",
			amount: 1200,
			jevCategoryId: eating,
		});

		const filed = await post("/transactions/organize/suggestion", {
			suggestion: String(suggestion),
			shown: pets.map(String),
		});

		expect(filed.res.status).toBe(200);
		expect(create).toHaveBeenCalledTimes(1);
		expect(reaskOf(0)?.ids).toEqual([related]);
	});

	it("the Settings typed-name create starts nothing", async () => {
		await post("/settings/categories", { name: "Hobbies" });
		expect(create).not.toHaveBeenCalled();
		expect(await readRun(db)).toBeNull();
	});
});

// #842 review: the Create already filed the category, so a failure in the re-check must never fail the Create. The
// failures are forced by making one statement throw, through the database's prepare, as a broken write would.
describe("a failing re-check never fails the Create (#842 review)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Makes every statement whose SQL contains `text` throw when it is prepared. */
	function failStatement(text: string) {
		const prepare = db.prepare.bind(db);
		vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			if (sql.includes(text)) throw new Error("forced failure");

			return prepare(sql);
		});
	}

	const maybeCreate = async () => {
		const { filed } = await maybeFixture();

		return post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
	};

	it("answers the Create as a success, with no line, when the run cannot be written (a failed CAS)", async () => {
		failStatement(
			"INSERT INTO household_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
		);
		const { res, html } = await maybeCreate();
		expect(res.status).toBe(200);
		expect(html).not.toContain("/resort/progress");
		expect(html).not.toContain('id="recheck"');
		expect(create).not.toHaveBeenCalled();
		vi.restoreAllMocks();

		const made = await db
			.prepare("SELECT id FROM categories WHERE name = 'Books & audio'")
			.first<{ id: number }>();

		expect(made?.id).toBeDefined();
	});

	it("answers the Create as a success, and ends the run it wrote, when a write after the run fails", async () => {
		// The sweep runs right after the run is written: its failure leaves a running record with no instance.
		failStatement("substr(key, 1, ?) = ?");
		const { res, html } = await maybeCreate();
		expect(res.status).toBe(200);
		expect(html).not.toContain("/resort/progress");
		expect(create).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		expect((await readRun(db))?.status).toBe("done");
	});
});

// #842 round 2 (Codex): the finished line leaves the page whole; Create and next keeps its card's rows out of the run;
// needAnswer counts only the rows the category queue still asks; and the closing toast's Undo redraws its own page.
describe("the re-check, round 2 of the #842 review", () => {
	/** The closing toast's poll for a finished run, its page key in the address (or none), and the run's id. */
	let shelves = 0;

	async function closingPoll(key?: string) {
		const { filed, related } = await maybeFixture();
		// A new category each time, so every call's Create makes a run of its own.
		shelves += 1;
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: `Shelf ${shelves}`,
		});
		const run = await readRun(db);
		const eating = await categoryId("Eating Out");
		await db
			.prepare(
				"UPDATE transactions SET category_id = ?, category_source = 'jev', category_confidence = NULL WHERE id = ?",
			)
			.bind(eating, related[0])
			.run();
		await finishRun(db, { runId: run?.id ?? "", now: Date.now() });
		const query = key === undefined ? "" : `&p=${key}`;
		const res = await get(`/resort/progress?run=${run?.id}${query}`);

		return { ...res, runId: run?.id ?? "" };
	}

	it("answers the running poll with the sentence alone, and every finished poll as a delete of the whole line", async () => {
		const runId = await seedRun(14);
		const running = await get(`/resort/progress?run=${runId}&m=0`);
		expect(running.res.headers.get("HX-Retarget")).toBeNull();
		expect(running.res.headers.get("HX-Reswap")).toBeNull();
		// The run ends without a closing toast (nothing moved, nothing waiting): the answer still removes the line.
		await db
			.prepare(
				"UPDATE household_settings SET value = json_set(value, '$.status', 'done') WHERE key = 'resort_run'",
			)
			.run();
		const finished = await get(`/resort/progress?run=${runId}&m=0`);
		expect(finished.html).toBe("");
		expect(finished.res.headers.get("HX-Retarget")).toBe("#recheck");
		expect(finished.res.headers.get("HX-Reswap")).toBe("delete");
		// An unknown run's answer removes the line too, so no stale line stays on a page.
		const unknown = await get("/resort/progress?run=no-such-run");
		expect(unknown.res.headers.get("HX-Reswap")).toBe("delete");
	});

	it("keeps the running line's wrapper, its milestone region and sentence, whole while the run goes", async () => {
		const { filed } = await maybeFixture();

		const { html } = await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});

		expect(html).toContain('<div id="recheck" class="mt-4">');
		expect(html).toContain('<p id="recheck-line"');
		expect(html).toContain('<span id="recheck-milestone" role="status"');
	});

	it("a Create and next keeps its card's same-text peers out of the run, so the card still offers them", async () => {
		const eating = await categoryId("Eating Out");
		const { filed, related } = await maybeFixture();

		const peer = await addRow({
			raw: LUPITA,
			amount: 2300,
			jevCategoryId: eating,
			confidence: 0.5,
			plaid: null,
		});

		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const ids = [...(reaskOf(0)?.ids ?? [])];
		expect(ids).not.toContain(peer);
		expect(ids.sort()).toEqual([...related].sort());
		const card = await moreLikeThis(db, filed);
		expect(card?.rows.map((row) => row.id)).toContain(peer);
	});

	it("counts as waiting only the rows the category queue still asks: a none-fit row and an excluded row are not", async () => {
		const eating = await categoryId("Eating Out");
		const { filed, related } = await maybeFixture();
		await addRow({ raw: "BOOKSHOP 3", amount: 1700, jevCategoryId: eating });
		await post("/settings/suggestions", {
			id: `category-${filed}`,
			answer: "create",
			new_name: "Books & audio",
		});
		const run = await readRun(db);
		// After the run starts: one row loses its guess to none-fit, one is excluded. Only the third row still waits.
		await db
			.prepare(
				"UPDATE transactions SET jev_category_id = NULL, jev_none_fit = 1 WHERE id = ?",
			)
			.bind(related[0])
			.run();
		await db
			.prepare(
				"UPDATE transactions SET excluded = 1, excluded_source = 'user' WHERE id = ?",
			)
			.bind(related[1])
			.run();
		await finishRun(db, { runId: run?.id ?? "", now: Date.now() });
		const { res } = await get(`/resort/progress?run=${run?.id}`);
		expect(trigger(res).toast?.message).toBe(
			"Nothing moved. 1 needs your answer.",
		);
	});

	it("the running line names its page in its address, so the closing toast can redraw that page", async () => {
		await seedRun(14);
		const organize = await get("/transactions/organize");
		expect(organize.html).toContain("&amp;p=organize");
		const categories = await get("/settings/categories");
		expect(categories.html).toContain("&amp;p=categories");
		const suggestions = await get("/settings/suggestions");
		expect(suggestions.html).toContain("&amp;p=suggestions");
	});

	it("gives the closing toast its page's own Undo target, and none for no key or a key it does not know", async () => {
		const pages: [string, string][] = [
			["suggestions", "#suggestions-page"],
			["organize", "#organize-page"],
			["categories", "#categories"],
		];

		for (const [key, target] of pages) {
			const { res } = await closingPoll(key);
			expect(trigger(res).toast?.undoTarget).toBe(target);
		}

		const none = await closingPoll();
		expect(trigger(none.res).toast?.undoTarget).toBeUndefined();
		expect(trigger(none.res).toast?.undo).toBeDefined();
		const unknown = await closingPoll("#page, body");
		expect(trigger(unknown.res).toast?.undoTarget).toBeUndefined();
	});

	it("the Undo answer for an Organize or a Settings categories toast draws that page, with its own element", async () => {
		const organize = await closingPoll("organize");

		const drawnOrganize = await post("/resort/undo", {
			token: organize.runId,
			back: "/transactions/organize",
		});

		expect(drawnOrganize.html).toContain('id="organize-page"');
		const categories = await closingPoll("categories");

		const drawnCategories = await post("/resort/undo", {
			token: categories.runId,
			back: "/settings/categories",
		});

		expect(drawnCategories.html).toContain('id="categories"');
	});
});
