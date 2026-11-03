import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import {
	finishRun,
	readMoved,
	readRun,
	startOrJoinRun,
} from "../src/db/resort-run";
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
		await addRow({ raw: "BOOKSHOP 1", amount: 1500 }),
		await addRow({ raw: "BOOKSHOP 2", amount: 1800 }),
	];
	return { filed, related, eating };
}

beforeEach(async () => {
	await resetDemo(db, "2026-09-22");
	await db.batch([
		db.prepare("DELETE FROM transactions"),
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
		expect(html).toContain(`hx-get="/resort/progress?run=${run?.id}"`);
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
		expect(html).toContain(`hx-get="/resort/progress?run=${run?.id}"`);
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
