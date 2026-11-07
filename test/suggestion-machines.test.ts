import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
	createFromSuggestion,
	dismissSuggestion,
	pendingSuggestions,
	saveSuggestion,
} from "../src/db/category-suggestions";
import {
	saveAskedNames,
	settleSuggestion,
	suggestBankNamesSql,
} from "../src/db/merchant-names";
import {
	CATEGORY_SUGGESTION_STATUS_VALUES,
	MERCHANT_STATUS_VALUES,
} from "../src/db/schema";
import { resetDemo } from "../src/demo/reset";
import {
	CATEGORY_SUGGESTION_LABELS,
	CATEGORY_SUGGESTION_STATUSES,
	CATEGORY_SUGGESTION_UNSAVED,
	type CategorySuggestionState,
	categorySuggestionMachine,
} from "../src/machines/category-suggestion";
import { machineGraph } from "../src/machines/graph";
import {
	MERCHANT_SUGGESTION_LABELS,
	MERCHANT_SUGGESTION_ROWS,
	MERCHANT_SUGGESTION_STATUSES,
	MERCHANT_SUGGESTION_WAITING,
	merchantSuggestionMachine,
	merchantSuggestionState,
} from "../src/machines/merchant-suggestion";
import { next } from "../src/machines/next";

// The two suggestion machines are the one place their rules are written. These tests keep the database's own
// checks and every store function in step with them: the allowed values, then each state met with each event.

const db = env.DB;

describe("the suggestion machines against the schema", () => {
	it("the machines' status lists are the schema's, as sets", () => {
		expect(new Set(CATEGORY_SUGGESTION_STATUSES)).toEqual(
			new Set(CATEGORY_SUGGESTION_STATUS_VALUES),
		);
		expect(new Set(MERCHANT_SUGGESTION_STATUSES)).toEqual(
			new Set(MERCHANT_STATUS_VALUES),
		);
	});

	it("the types agree: category states minus born are the schema's values, merchant rows use the schema's values", () => {
		expectTypeOf<
			Exclude<CategorySuggestionState, "born">
		>().toEqualTypeOf<(typeof CATEGORY_SUGGESTION_STATUS_VALUES)[number]>();
		expectTypeOf<
			(typeof MERCHANT_SUGGESTION_ROWS)[keyof typeof MERCHANT_SUGGESTION_ROWS]["status"]
		>().toExtend<(typeof MERCHANT_STATUS_VALUES)[number]>();
	});

	it("the state a name is shown from is one the machine can still decide", () => {
		expect(
			next(merchantSuggestionMachine, MERCHANT_SUGGESTION_WAITING, "ACCEPT"),
		).toBe("accepted");
	});

	it("every state has a short word for its diagram box, and no word is for a state that is gone", () => {
		expect(Object.keys(CATEGORY_SUGGESTION_LABELS).sort()).toEqual(
			[...CATEGORY_SUGGESTION_STATUSES, CATEGORY_SUGGESTION_UNSAVED].sort(),
		);
		expect(Object.keys(MERCHANT_SUGGESTION_LABELS).sort()).toEqual(
			Object.keys(merchantSuggestionMachine.states).sort(),
		);
	});
});

describe("every state met with every event", () => {
	it("category suggestion: only a waiting suggestion moves, and finished ones refuse everything", () => {
		const moves: Record<string, Record<string, string | null>> = {
			born: { NAME: "pending", NAMELESS: "none" },
			pending: { ACCEPT: "created", DISMISS: "dismissed", EMPTY: "none" },
			created: { ACCEPT: null, DISMISS: null, EMPTY: null },
			dismissed: { ACCEPT: null, DISMISS: null, EMPTY: null },
			none: { ACCEPT: null, DISMISS: null, EMPTY: null },
		};
		// A stored suggestion is never born again, and an unsaved one cannot be decided.
		for (const state of CATEGORY_SUGGESTION_STATUSES)
			for (const event of ["NAME", "NAMELESS"])
				expect(
					next(categorySuggestionMachine, state, event),
					`${state} ${event}`,
				).toBeNull();
		for (const event of ["ACCEPT", "DISMISS", "EMPTY"])
			expect(
				next(categorySuggestionMachine, "born", event),
				`born ${event}`,
			).toBeNull();
		for (const [state, events] of Object.entries(moves))
			for (const [event, target] of Object.entries(events))
				expect(
					next(categorySuggestionMachine, state, event),
					`${state} ${event}`,
				).toBe(target);
		expect(machineGraph(categorySuggestionMachine).edges).toHaveLength(5);
	});

	it("merchant suggestion: a name is offered, then decided or withdrawn; decided ones refuse everything", () => {
		const none = {
			BANK_NAME: null,
			NAMES: null,
			NO_NAMES: null,
			ACCEPT: null,
			REJECT: null,
			WITHDRAW: null,
		};
		const moves: Record<string, Record<string, string | null>> = {
			none: {
				...none,
				BANK_NAME: "pending",
				NAMES: "pending",
				NO_NAMES: "asked",
			},
			asked: { ...none, BANK_NAME: "pending" },
			pending: {
				...none,
				BANK_NAME: "pending",
				ACCEPT: "accepted",
				REJECT: "rejected",
				WITHDRAW: "none",
			},
			accepted: none,
			rejected: none,
		};
		expect(Object.keys(moves).sort()).toEqual(
			Object.keys(merchantSuggestionMachine.states).sort(),
		);
		for (const [state, events] of Object.entries(moves))
			for (const [event, target] of Object.entries(events))
				expect(
					next(merchantSuggestionMachine, state, event),
					`${state} ${event}`,
				).toBe(target);
		expect(machineGraph(merchantSuggestionMachine).edges).toHaveLength(8);
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
	const eligible = async () => {
		const ids: number[] = [];
		for (let i = 0; i < 3; i++) {
			const row = await db
				.prepare(
					`INSERT INTO transactions (account_id, date, amount_cents, raw_name, plaid_category,
						category_confidence, jev_none_fit, excluded, flag_income, is_split, pending)
					 VALUES (1, '2026-09-20', 1500, 'NETFLIX.COM', 'ENTERTAINMENT', 0.93, 1, 0, 0, 0, 0) RETURNING id`,
				)
				.first<{ id: number }>();
			ids.push(row?.id as number);
		}
		return ids;
	};

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

	it("a new group is stored as waiting when it has a usable name and as nothing when it has none, as the machine says", async () => {
		const named = await saveSuggestion(db, "Streaming", await eligible());
		const nameless = await saveSuggestion(db, null, await eligible());
		expect(await statusOf(named as number)).toBe(
			next(categorySuggestionMachine, CATEGORY_SUGGESTION_UNSAVED, "NAME"),
		);
		expect(await statusOf(nameless as number)).toBe(
			next(categorySuggestionMachine, CATEGORY_SUGGESTION_UNSAVED, "NAMELESS"),
		);
	});

	it("accepting a waiting suggestion creates the category and moves it where the machine says", async () => {
		const purchases = await eligible();
		const id = (await saveSuggestion(db, "Zed Streaming", purchases)) as number;
		expect(await statusOf(id)).toBe("pending");
		const result = await createFromSuggestion(
			db,
			id,
			{ ticked: purchases, shown: purchases, notes: {} },
			"person",
		);
		expect(result).toMatchObject({ ok: true });
		expect(await statusOf(id)).toBe(
			next(categorySuggestionMachine, "pending", "ACCEPT"),
		);
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
	const states = Object.keys(
		merchantSuggestionMachine.states,
	) as (keyof typeof MERCHANT_SUGGESTION_ROWS)[];

	beforeEach(async () => {
		await resetDemo(db, "2026-09-22");
	});

	async function seed(state: keyof typeof MERCHANT_SUGGESTION_ROWS) {
		const row = MERCHANT_SUGGESTION_ROWS[state] as NonNullable<
			(typeof MERCHANT_SUGGESTION_ROWS)[typeof state]
		>;
		await db.prepare("DELETE FROM merchants WHERE raw_name = 'ZED CAFE'").run();
		await db
			.prepare(
				"INSERT INTO merchants (raw_name, suggested_name, suggestion_status) VALUES ('ZED CAFE', ?, ?)",
			)
			.bind(row.suggestedName, row.status)
			.run();
	}
	/** The machine's state for the stored row, so every check reads one answer. */
	const stateNow = async () => {
		const row = await db
			.prepare(
				"SELECT suggestion_status AS status, suggested_name AS suggestedName FROM merchants WHERE raw_name = 'ZED CAFE'",
			)
			.first<{ status: string; suggestedName: string | null }>();
		return merchantSuggestionState(row as NonNullable<typeof row>);
	};

	it("every state is stored in a way that reads back as that state", async () => {
		for (const state of states) {
			await seed(state);
			expect(await stateNow(), state).toBe(state);
		}
	});

	it("a bank's name moves a row exactly where the machine says", async () => {
		for (const state of states) {
			await seed(state);
			await db
				.prepare(suggestBankNamesSql("1"))
				.bind(JSON.stringify(["ZED CAFE"]))
				.run();
			expect(await stateNow(), `${state} after BANK_NAME`).toBe(
				next(merchantSuggestionMachine, state, "BANK_NAME") ?? state,
			);
		}
	});

	it("Workers AI's names move a row exactly where the machine says", async () => {
		for (const state of states) {
			await seed(state);
			await saveAskedNames(
				db,
				[{ rawName: "ZED CAFE", names: ["Zed Cafe"] }],
				[],
			);
			expect(await stateNow(), `${state} after NAMES`).toBe(
				next(merchantSuggestionMachine, state, "NAMES") ?? state,
			);
		}
	});

	it("Workers AI's empty answer moves a row exactly where the machine says", async () => {
		for (const state of states) {
			await seed(state);
			await saveAskedNames(db, [{ rawName: "ZED CAFE", names: [] }], []);
			expect(await stateNow(), `${state} after NO_NAMES`).toBe(
				next(merchantSuggestionMachine, state, "NO_NAMES") ?? state,
			);
		}
	});

	it("picking a suggested name accepts, exactly where the machine says", async () => {
		for (const state of states) {
			await seed(state);
			await settleSuggestion(db, "ZED CAFE", {
				kind: "name",
				name: "Zed Cafe",
			});
			expect(await stateNow(), `${state} after ACCEPT`).toBe(
				next(merchantSuggestionMachine, state, "ACCEPT") ?? state,
			);
		}
	});

	it("typing their own name, or keeping the bank's, rejects, exactly where the machine says", async () => {
		for (const choice of [
			{ kind: "name", name: "My own name" },
			{ kind: "keep" },
		] as const) {
			for (const state of states) {
				await seed(state);
				await settleSuggestion(db, "ZED CAFE", choice);
				expect(await stateNow(), `${state} after REJECT (${choice.kind})`).toBe(
					next(merchantSuggestionMachine, state, "REJECT") ?? state,
				);
			}
		}
	});
});
