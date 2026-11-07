import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createFromSuggestion,
	dismissSuggestion,
	pendingSuggestions,
} from "../src/db/category-suggestions";
import {
	settleSuggestion,
	suggestBankNamesSql,
} from "../src/db/merchant-names";
import { resetDemo } from "../src/demo/reset";
import {
	CATEGORY_SUGGESTION_LABELS,
	CATEGORY_SUGGESTION_STATUSES,
	categorySuggestionMachine,
} from "../src/machines/category-suggestion";
import { machineGraph } from "../src/machines/graph";
import {
	MERCHANT_SUGGESTION_LABELS,
	MERCHANT_SUGGESTION_STATUSES,
	MERCHANT_SUGGESTION_WAITING,
	merchantSuggestionMachine,
} from "../src/machines/merchant-suggestion";
import { next } from "../src/machines/next";

// The two suggestion machines are the one place their rules are written. These tests keep the database's own
// checks and every store function in step with them: the allowed values, then each state met with each event.

const db = env.DB;

/** The values a column's CHECK allows, read from the live schema. */
async function allowedBy(table: string, column: string): Promise<string[]> {
	const row = await db
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
		.bind(table)
		.first<{ sql: string }>();
	const check = row?.sql.match(
		new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`),
	);
	expect(check, `${table}.${column} has no CHECK`).not.toBeNull();
	return [...(check?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

describe("the suggestion machines against the schema", () => {
	it("category suggestions allow exactly the machine's states", async () => {
		expect((await allowedBy("category_suggestions", "status")).sort()).toEqual(
			[...CATEGORY_SUGGESTION_STATUSES].sort(),
		);
	});

	it("merchant suggestions allow exactly the machine's states", async () => {
		expect((await allowedBy("merchants", "suggestion_status")).sort()).toEqual(
			[...MERCHANT_SUGGESTION_STATUSES].sort(),
		);
	});

	it("the state a name is shown from is one the machine can still decide", () => {
		expect(
			next(merchantSuggestionMachine, MERCHANT_SUGGESTION_WAITING, "ACCEPT"),
		).toBe("accepted");
	});

	it("every state has a short word for its diagram box, and no word is for a state that is gone", () => {
		expect(Object.keys(CATEGORY_SUGGESTION_LABELS).sort()).toEqual(
			[...CATEGORY_SUGGESTION_STATUSES].sort(),
		);
		expect(Object.keys(MERCHANT_SUGGESTION_LABELS).sort()).toEqual(
			[...MERCHANT_SUGGESTION_STATUSES].sort(),
		);
	});
});

describe("every state met with every event", () => {
	it("category suggestion: only a waiting suggestion moves, and finished ones refuse everything", () => {
		const moves: Record<string, Record<string, string | null>> = {
			pending: { ACCEPT: "created", DISMISS: "dismissed", EMPTY: "none" },
			created: { ACCEPT: null, DISMISS: null, EMPTY: null },
			dismissed: { ACCEPT: null, DISMISS: null, EMPTY: null },
			none: { ACCEPT: null, DISMISS: null, EMPTY: null },
		};
		for (const [state, events] of Object.entries(moves))
			for (const [event, target] of Object.entries(events))
				expect(
					next(categorySuggestionMachine, state, event),
					`${state} ${event}`,
				).toBe(target);
		expect(machineGraph(categorySuggestionMachine).edges).toHaveLength(3);
	});

	it("merchant suggestion: a name is offered, then decided or withdrawn; decided ones refuse everything", () => {
		const moves: Record<string, Record<string, string | null>> = {
			none: { SUGGEST: "pending", ACCEPT: null, REJECT: null, WITHDRAW: null },
			pending: {
				SUGGEST: "pending",
				ACCEPT: "accepted",
				REJECT: "rejected",
				WITHDRAW: "none",
			},
			accepted: { SUGGEST: null, ACCEPT: null, REJECT: null, WITHDRAW: null },
			rejected: { SUGGEST: null, ACCEPT: null, REJECT: null, WITHDRAW: null },
		};
		for (const [state, events] of Object.entries(moves))
			for (const [event, target] of Object.entries(events))
				expect(
					next(merchantSuggestionMachine, state, event),
					`${state} ${event}`,
				).toBe(target);
		expect(machineGraph(merchantSuggestionMachine).edges).toHaveLength(5);
	});
});

describe("the category suggestion store follows its machine", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.prepare("DELETE FROM category_suggestions").run();
	});

	async function seed(status: string): Promise<number> {
		const row = await db
			.prepare(
				"INSERT INTO category_suggestions (name, status) VALUES ('Pet Care', ?) RETURNING id",
			)
			.bind(status)
			.first<{ id: number }>();
		return row?.id as number;
	}
	const statusOf = async (id: number) =>
		(
			await db
				.prepare("SELECT status FROM category_suggestions WHERE id = ?")
				.bind(id)
				.first<{ status: string }>()
		)?.status;

	it("dismiss moves a row exactly where the machine says, and refuses where it says null", async () => {
		for (const state of CATEGORY_SUGGESTION_STATUSES) {
			const id = await seed(state);
			const result = await dismissSuggestion(db, id);
			const target = next(categorySuggestionMachine, state, "DISMISS");
			expect(result !== null, `${state}: dismiss answered`).toBe(
				target !== null,
			);
			expect(await statusOf(id), `${state}: status after dismiss`).toBe(
				target ?? state,
			);
		}
	});

	it("a suggestion nothing backs any more empties exactly where the machine says", async () => {
		for (const state of CATEGORY_SUGGESTION_STATUSES) {
			const id = await seed(state);
			await pendingSuggestions(db);
			expect(await statusOf(id), `${state}: status after the sweep`).toBe(
				next(categorySuggestionMachine, state, "EMPTY") ?? state,
			);
		}
	});

	it("accepting a suggestion that is no longer waiting is refused where the machine refuses it", async () => {
		// The successful accept, from `pending`, has its own tests in category-suggestions-db.test.ts; this
		// walks the states that must refuse, so a new state without a rule fails here.
		for (const state of CATEGORY_SUGGESTION_STATUSES) {
			if (next(categorySuggestionMachine, state, "ACCEPT") !== null) continue;
			const id = await seed(state);
			expect(
				await createFromSuggestion(
					db,
					id,
					{ ticked: [1], shown: [1], notes: {} },
					"person",
				),
				state,
			).toEqual({ ok: false, reason: "gone" });
			expect(await statusOf(id)).toBe(state);
		}
	});
});

describe("the merchant suggestion store follows its machine", () => {
	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
		await db.prepare("DELETE FROM merchants WHERE raw_name = 'ZED CAFE'").run();
	});

	async function seed(status: string) {
		await db.prepare("DELETE FROM merchants WHERE raw_name = 'ZED CAFE'").run();
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('ZED CAFE', 'Zed Cafe', ?)",
			)
			.bind(status)
			.run();
	}
	const statusOf = async () =>
		(
			await db
				.prepare(
					"SELECT suggestion_status AS s FROM merchants WHERE raw_name = 'ZED CAFE'",
				)
				.first<{ s: string }>()
		)?.s;

	it("an offered name moves a row exactly where the machine says", async () => {
		for (const state of MERCHANT_SUGGESTION_STATUSES) {
			await seed(state);
			await db
				.prepare(suggestBankNamesSql("1"))
				.bind(JSON.stringify(["ZED CAFE"]))
				.run();
			expect(await statusOf(), `${state} after SUGGEST`).toBe(
				next(merchantSuggestionMachine, state, "SUGGEST") ?? state,
			);
		}
	});

	it("picking a suggested name accepts, exactly where the machine says", async () => {
		for (const state of MERCHANT_SUGGESTION_STATUSES) {
			await seed(state);
			await settleSuggestion(db, "ZED CAFE", {
				kind: "name",
				name: "Zed Cafe",
			});
			expect(await statusOf(), `${state} after ACCEPT`).toBe(
				next(merchantSuggestionMachine, state, "ACCEPT") ?? state,
			);
		}
	});

	it("typing their own name, or keeping the bank's, rejects, exactly where the machine says", async () => {
		for (const choice of [
			{ kind: "name", name: "My own name" },
			{ kind: "keep" },
		] as const) {
			for (const state of MERCHANT_SUGGESTION_STATUSES) {
				await seed(state);
				await settleSuggestion(db, "ZED CAFE", choice);
				expect(await statusOf(), `${state} after REJECT (${choice.kind})`).toBe(
					next(merchantSuggestionMachine, state, "REJECT") ?? state,
				);
			}
		}
	});
});
