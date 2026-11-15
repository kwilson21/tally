import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveSplit } from "../src/db/transactions";
import { resetDemo } from "../src/demo/reset";
import { pinClock } from "./pinned-clock";

// Three fixes on top of the edit panel's file-as-not-posted note (#1133). Each test fails on the commit before them
// (c6c336c4) and passes on the branch: a refused panel redraws the saved note in both boxes, a Change the parts replay
// carries the file marker as "1" and never a copied "0", and a replayed pending edit that is refused redraws the saved
// note so that resubmitting cannot clear it.

const db = env.DB;
const BASE = "http://tally.test";
const LIST = "/transactions?month=all";
const SAVED = "Saved note";

afterEach(() => {
	vi.useRealTimers();
});

type Ids = {
	id: number;
	cash: number;
	cat: number;
	arch: number;
	partA: number;
	partB: number;
};

/** Seeds a purchase and a cash entry split into two parts, both with the saved note, and an archived category. */
async function seed(): Promise<Ids> {
	pinClock();
	await resetDemo(db, todayIn(DEFAULT_TIME_ZONE));

	const first = async (sql: string) => {
		const row = await db.prepare(sql).first<{ id: number }>();

		if (!row) throw new Error(`seed missing: ${sql}`);

		return row.id;
	};

	const cat = await first(
		"SELECT id FROM categories WHERE archived=0 ORDER BY id LIMIT 1",
	);

	const arch = await db
		.prepare(
			"SELECT id FROM categories WHERE archived=0 AND id<>? ORDER BY id DESC LIMIT 1",
		)
		.bind(cat)
		.first<{ id: number }>();

	if (!arch) throw new Error("seed missing: a second category");

	await db
		.prepare("UPDATE categories SET archived=1 WHERE id=?")
		.bind(arch.id)
		.run();

	const id = await first(
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type<>'cash' AND t.parent_id IS NULL AND t.refund_of_id IS NULL AND t.is_split=0 ORDER BY t.id LIMIT 1",
	);

	const cash = await first(
		"SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.type='cash' AND t.parent_id IS NULL ORDER BY t.id LIMIT 1",
	);

	await db
		.prepare("UPDATE transactions SET amount_cents=9000 WHERE id=?")
		.bind(cash)
		.run();
	await saveSplit(
		db,
		cash,
		[
			{ amountCents: 6000, categoryId: cat },
			{ amountCents: 3000, categoryId: arch.id },
		],
		"demo",
	);

	const parts = await db
		.prepare(
			"SELECT id FROM transactions WHERE parent_id=? ORDER BY id LIMIT 2",
		)
		.bind(cash)
		.all<{ id: number }>();

	await db
		.prepare(
			"UPDATE transactions SET note=?, note_state='written' WHERE id IN (?, ?)",
		)
		.bind(SAVED, id, cash)
		.run();

	return {
		id,
		cash,
		cat,
		arch: arch.id,
		partA: parts.results[0]?.id ?? 0,
		partB: parts.results[1]?.id ?? 0,
	};
}

const noteOf = async (id: number) =>
	(
		await db
			.prepare("SELECT note FROM transactions WHERE id=?")
			.bind(id)
			.first<{ note: string | null }>()
	)?.note ?? null;

const file = () => new File(["x"], "x.txt", { type: "text/plain" });

/** A POST as the browser or a crafted request sends it; entries with a null value are left out. */
async function post(path: string, entries: [string, string | File | null][]) {
	const headers = new Headers({ "HX-Request": "true", Origin: BASE });
	const body = new FormData();

	for (const [key, value] of entries) {
		if (value !== null) body.append(key, value);
	}

	const res = await exports.default.fetch(`${BASE}${path}`, {
		method: "POST",
		headers,
		body,
	});

	return { res, html: await res.text() };
}

/** The textarea's text and the hidden note_was value a panel was drawn with. */
function drawnNote(html: string) {
	const area = /<textarea[^>]*name="note"[^>]*>([\s\S]*?)<\/textarea>/.exec(
		html,
	);

	const was = /name="note_was"\s+value="([^"]*)"/.exec(html);

	return {
		note: area?.[1]?.replaceAll("&amp;", "&") ?? null,
		noteWas: was?.[1]?.replaceAll("&amp;", "&") ?? null,
	};
}

/** The Change the parts sheet's pending edit, read from its hidden input (HTML-escaped). */
function pendingOf(html: string): string {
	const value = /name="pending_edit" value="([^"]*)"/.exec(html)?.[1];

	if (value === undefined) throw new Error("no sheet");

	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

describe("the edit panel's note when a file is posted in it (#1133 Codex findings)", () => {
	it("(a) a refused panel with details off and a file in note_was redraws the saved note, and a resubmit keeps it", async () => {
		const base: [string, string | File | null][] = [
			["category", "abc"],
			["name_pick", "own"],
			["merchant", "Corpus name"],
			["back", LIST],
			["details_visible", "0"],
		];

		for (const note of ["", null] as const) {
			const ids = await seed();

			const redraw = await post(`/transactions/${ids.id}`, [
				...base,
				["note", note],
				["note_was", file()],
			]);

			expect(redraw.res.status).toBe(422);
			expect(drawnNote(redraw.html)).toEqual({ note: SAVED, noteWas: SAVED });

			// Resubmit the redraw as drawn, with the category fixed: the saved note must survive.
			const resubmit = await post(`/transactions/${ids.id}`, [
				["category", String(ids.cat)],
				["name_pick", "own"],
				["merchant", "Corpus name"],
				["back", LIST],
				["details_visible", "0"],
				["note", SAVED],
				["note_was", SAVED],
			]);

			expect(resubmit.res.status).toBe(200);
			expect(await noteOf(ids.id)).toBe(SAVED);
		}
	});

	it("(b) a Change the parts post with a file in note and a crafted note_not_posted=0 replays and keeps the saved note", async () => {
		const ids = await seed();

		const panel = await post(`/transactions/${ids.cash}`, [
			["category", String(ids.cat)],
			["name_pick", "own"],
			["merchant", "Corpus name"],
			["back", LIST],
			["details_visible", "1"],
			["note", file()],
			["note_was", SAVED],
			["note_not_posted", "0"],
			["amount", "100.00"],
			["change_parts", "1"],
		]);

		expect(panel.res.status).toBe(200);

		const pending = pendingOf(panel.html);

		expect(new URLSearchParams(pending).getAll("note_not_posted")).toEqual([
			"1",
		]);

		const split = await post(`/transactions/${ids.cash}/split`, [
			["back", LIST],
			["total", "10000"],
			["amount_was", "9000"],
			["part_id", String(ids.partA)],
			["part_id", String(ids.partB)],
			["part_category", String(ids.cat)],
			["part_category", String(ids.arch)],
			["part_amount", "60.00"],
			["part_amount", "40.00"],
			["pending_edit", pending],
		]);

		expect(split.res.status).toBe(200);
		expect(await noteOf(ids.cash)).toBe(SAVED);
	});

	it("(c) a replayed pending edit with the marker and no note, refused, redraws the saved note; resubmitting keeps it", async () => {
		const ids = await seed();

		const pending = new URLSearchParams({
			category: String(ids.arch),
			name_pick: "own",
			merchant: "Corpus name",
			back: LIST,
			details_visible: "1",
			note_was: SAVED,
			note_not_posted: "1",
		}).toString();

		const refused = await post(`/transactions/${ids.cash}/split`, [
			["back", LIST],
			["total", "10000"],
			["amount_was", "9000"],
			["part_id", String(ids.partA)],
			["part_id", String(ids.partB)],
			["part_category", String(ids.cat)],
			["part_category", String(ids.arch)],
			["part_amount", "60.00"],
			["part_amount", "40.00"],
			["pending_edit", pending],
		]);

		expect(refused.res.status).toBeGreaterThanOrEqual(400);
		expect(drawnNote(refused.html).note).toBe(SAVED);
		expect(await noteOf(ids.cash)).toBe(SAVED);

		const drawn = drawnNote(refused.html);

		const resubmit = await post(`/transactions/${ids.cash}`, [
			["category", String(ids.cat)],
			["name_pick", "own"],
			["merchant", "Corpus name"],
			["back", LIST],
			["details_visible", "1"],
			["note", drawn.note ?? ""],
			["note_was", drawn.noteWas ?? ""],
		]);

		expect(resubmit.res.status).toBe(200);
		expect(await noteOf(ids.cash)).toBe(SAVED);
	});
});
