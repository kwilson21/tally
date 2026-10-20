import { describe, expect, it, vi } from "vitest";
import { formatReport } from "../scripts/compare-models/report";
import {
	buildCases,
	type Case,
	demoCategories,
	fiftyCategories,
	type Row,
	scoreCase,
	summarize,
} from "../scripts/compare-models/score";
import worker, {
	runComparison,
	viaWorkersAI,
} from "../scripts/compare-models/worker";
import { JEV_URL, type JevResult } from "../src/ai/categorize";
import { type Flag, type JevAnswer, NONE_FIT } from "../src/ai/decide";
import { buildSeed, type Seed, type SeedTransaction } from "../src/demo/seed";

const TODAY = "2026-10-19";
const NAMES = ["Groceries", "Eating Out", "Household"];
const NO_FLAGS = { transfer: false, reimbursement: false, income: false };

// ---- Builders ------------------------------------------------------------

const jevAnswer = (
	label: string,
	confidence: number,
	flags: Partial<Record<Flag, number>> = {},
	extra: Partial<JevAnswer> = {},
): JevAnswer => ({
	category: { label, confidence },
	flags: { transfer: 0, reimbursement: 0, income: 0, ...flags },
	...extra,
});

const ok = (answer: JevAnswer): JevResult => ({ ok: true, answer });

const kase = (over: Partial<Case> = {}): Case => ({
	rawName: "STORE",
	direction: "money out",
	input: {
		rawName: "STORE",
		displayName: null,
		amountCents: 1000,
		accountType: "credit",
	},
	rightCategory: "Groceries",
	flags: NO_FLAGS,
	...over,
});

/** A Workers AI or Jev answer that reads cleanly with the demo's options. */
const modelAnswer = (choice = "Groceries") => ({
	model: "clef",
	answers: {
		category: { type: "choice", choice, confidence: 0.95 },
		transfer: { type: "noul", noul: 0.05 },
		reimbursement: { type: "noul", noul: 0.05 },
		income: { type: "noul", noul: 0.05 },
		mixed: { type: "noul", noul: 0.1 },
		also_category: { type: "choice", choice: NONE_FIT, confidence: 0.9 },
		kind: { type: "choice", choice: "one_off", confidence: 0.9 },
		for_person: { type: "choice", choice: "none", confidence: 0.9 },
		note_worth_writing: { type: "noul", noul: 0.1 },
	},
	usage: { input_tokens: 100, output_tokens: 1 },
});

type RunArgs = [string, Record<string, unknown>, { signal?: unknown }];

/** A fake Workers AI. `run` decides each answer, and every call is recorded. */
const fakeAi = (
	run: (model: string, body: Record<string, unknown>) => unknown = (
		_model,
		body,
	) => ({
		...modelAnswer(),
		model: body.model,
	}),
) =>
	({
		run: vi.fn(async (model: string, body: Record<string, unknown>) =>
			run(model, body),
		),
	}) as unknown as Ai & { run: ReturnType<typeof vi.fn> };

const callsOf = (ai: { run: ReturnType<typeof vi.fn> }) =>
	ai.run.mock.calls as RunArgs[];

const CLEF = "@cf/cloudflare/clef";
const CLEF_FLASH = "@cf/cloudflare/clef-flash";
const demoCaseCount = buildCases(buildSeed(TODAY)).length;

// ---- A hand-made seed ----------------------------------------------------

const tx = (
	over: Partial<SeedTransaction> & Pick<SeedTransaction, "rawName">,
): SeedTransaction => ({
	accountId: 3,
	date: "2026-10-02",
	amountCents: 1000,
	categoryId: null,
	categorySource: null,
	categoryConfidence: null,
	flagTransfer: false,
	flagReimbursement: false,
	flagIncome: false,
	excluded: false,
	isSplit: false,
	parentId: null,
	merchantName: null,
	...over,
});

const handSeed = (transactions: SeedTransaction[]): Seed => ({
	categories: [
		{
			id: 1,
			name: "Groceries",
			icon: "groceries",
			color: "cat-blue",
			sortOrder: 1,
		},
		{
			id: 2,
			name: "Eating Out",
			icon: "eating-out",
			color: "cat-plum",
			sortOrder: 2,
		},
		{
			id: 5,
			name: "Household",
			icon: "household",
			color: "cat-brown",
			sortOrder: 3,
		},
	],
	banks: [],
	accounts: [
		{
			id: 1,
			bankId: null,
			name: "Checking",
			mask: null,
			type: "depository",
			subtype: "checking",
			isLiability: false,
			balanceCents: 0,
		},
		{
			id: 3,
			bankId: null,
			name: "Card",
			mask: null,
			type: "credit",
			subtype: "credit card",
			isLiability: true,
			balanceCents: 0,
		},
		{
			id: 4,
			bankId: null,
			name: "Cash",
			mask: null,
			type: "cash",
			subtype: "cash",
			isLiability: false,
			balanceCents: 0,
		},
	],
	balanceHistory: [],
	merchants: [],
	budgetAmounts: [],
	transactions,
});

// ---- Cases ---------------------------------------------------------------

describe("buildCases", () => {
	const seed = handSeed([
		// A split purchase: the parent and its two parts are all skipped.
		tx({
			id: 1,
			rawName: "COSTCO",
			amountCents: 18742,
			categoryId: 1,
			isSplit: true,
		}),
		tx({
			id: 2,
			rawName: "COSTCO",
			amountCents: 15000,
			categoryId: 1,
			parentId: 1,
		}),
		tx({
			id: 3,
			rawName: "COSTCO",
			amountCents: 3742,
			categoryId: 5,
			parentId: 1,
		}),
		// A store seen three times, and its refund (money in) as a separate case.
		tx({ id: 4, rawName: "BLUE BOTTLE", amountCents: 650, categoryId: 2 }),
		tx({ id: 5, rawName: "BLUE BOTTLE", amountCents: 700, categoryId: 2 }),
		tx({ id: 6, rawName: "BLUE BOTTLE", amountCents: 500, categoryId: 2 }),
		tx({ id: 7, rawName: "BLUE BOTTLE", amountCents: -650, categoryId: 2 }),
		// A store with a Plaid merchant name and no category.
		tx({
			id: 8,
			rawName: "CHECKCARD 0921 CVS",
			amountCents: 1643,
			merchantName: "CVS Pharmacy",
		}),
		// A store whose first row has no category and a later row does.
		tx({ id: 9, rawName: "APPLE.COM/BILL", amountCents: 299 }),
		tx({ id: 10, rawName: "APPLE.COM/BILL", amountCents: 299, categoryId: 5 }),
		// A row with no category at all.
		tx({ id: 11, rawName: "SQ *FARMERS", amountCents: 700 }),
		// A transfer, flagged and with no category.
		tx({
			id: 12,
			rawName: "ONLINE TRANSFER TO SAV",
			amountCents: 50000,
			flagTransfer: true,
			excluded: true,
			accountId: 1,
		}),
		// A cash row is never sent.
		tx({
			id: 13,
			rawName: "Farmers market",
			amountCents: 2000,
			categoryId: 1,
			accountId: 4,
		}),
	]);
	const cases = buildCases(seed);
	const byKey = (rawName: string, direction: Case["direction"]) =>
		cases.find((c) => c.rawName === rawName && c.direction === direction);

	it("makes one case per raw name and direction, skipping split and cash rows", () => {
		expect(cases.map((c) => `${c.rawName}|${c.direction}`)).toEqual([
			"BLUE BOTTLE|money out",
			"BLUE BOTTLE|money in",
			"CHECKCARD 0921 CVS|money out",
			"APPLE.COM/BILL|money out",
			"SQ *FARMERS|money out",
			"ONLINE TRANSFER TO SAV|money out",
		]);
		expect(cases.some((c) => c.rawName === "COSTCO")).toBe(false);
		expect(cases.some((c) => c.rawName === "Farmers market")).toBe(false);
	});

	it("takes the input from the first row, with the displayName and accountType it has", () => {
		expect(byKey("BLUE BOTTLE", "money out")?.input).toEqual({
			rawName: "BLUE BOTTLE",
			displayName: null,
			amountCents: 650,
			accountType: "credit",
		});
		expect(byKey("CHECKCARD 0921 CVS", "money out")?.input).toEqual({
			rawName: "CHECKCARD 0921 CVS",
			displayName: "CVS Pharmacy",
			amountCents: 1643,
			accountType: "credit",
		});
	});

	it("takes the right answer from the first category any row has, in array order", () => {
		expect(byKey("BLUE BOTTLE", "money out")?.rightCategory).toBe("Eating Out");
		expect(byKey("BLUE BOTTLE", "money in")?.rightCategory).toBe("Eating Out");
		// The first APPLE row has no category; the second is Household.
		expect(byKey("APPLE.COM/BILL", "money out")?.rightCategory).toBe(
			"Household",
		);
		expect(byKey("APPLE.COM/BILL", "money out")?.input.displayName).toBeNull();
	});

	it("has no right answer for a row with no category, and carries the seeded flags", () => {
		expect(byKey("SQ *FARMERS", "money out")?.rightCategory).toBeNull();
		const transfer = byKey("ONLINE TRANSFER TO SAV", "money out");
		expect(transfer?.rightCategory).toBeNull();
		expect(transfer?.flags).toEqual({
			transfer: true,
			reimbursement: false,
			income: false,
		});
	});

	it("gives the demo seed one case per raw name and direction, and every demo category as an answer", () => {
		const demo = buildCases(buildSeed(TODAY));
		expect(demo.length).toBe(36);
		const answers = new Set(demo.map((c) => c.rightCategory));
		for (const name of demoCategories(buildSeed(TODAY))) {
			expect(answers.has(name)).toBe(true);
		}
	});
});

// ---- Category lists ------------------------------------------------------

describe("category lists", () => {
	const seed = buildSeed(TODAY);

	it("the demo list is the demo's seven categories in sort order", () => {
		expect(demoCategories(seed)).toEqual([
			"Groceries",
			"Eating Out",
			"Gas",
			"Kids",
			"Household",
			"Childcare",
			"Rent",
		]);
	});

	it("the fifty list has fifty different names: the demo's seven, the nine starting ones, then thirty-four more", () => {
		const fifty = fiftyCategories(seed);
		expect(fifty.length).toBe(50);
		expect(new Set(fifty).size).toBe(50);
		expect(fifty.slice(0, 7)).toEqual(demoCategories(seed));
		expect(fifty.slice(7, 16)).toEqual([
			"Car & Transport",
			"Utilities",
			"Subscriptions",
			"Shopping",
			"Personal Care",
			"Health",
			"Entertainment",
			"Date Night",
			"Donations & Charity",
		]);
	});
});

// ---- Scoring -------------------------------------------------------------

describe("scoreCase", () => {
	it("scores a right pick at exactly 0.80 as right", () => {
		const row = scoreCase(kase(), ok(jevAnswer("Groceries", 0.8)), NAMES, 120);
		expect(row.outcome).toBe("right");
	});

	it("leaves a right pick at 0.7999 unsure, but still counts it as the right pick", () => {
		const row = scoreCase(
			kase(),
			ok(jevAnswer("Groceries", 0.7999)),
			NAMES,
			120,
		);
		expect(row.outcome).toBe("left: unsure");
		expect(row.answer?.rightPick).toBe(true);
	});

	it("leaves a right pick at 0.70 unsure and counts it as the right pick", () => {
		const row = scoreCase(kase(), ok(jevAnswer("Groceries", 0.7)), NAMES, 120);
		expect(row.outcome).toBe("left: unsure");
		expect(row.answer?.rightPick).toBe(true);
	});

	it("scores a confident wrong pick as wrong", () => {
		const row = scoreCase(
			kase(),
			ok(jevAnswer("Eating Out", 0.95)),
			NAMES,
			120,
		);
		expect(row.outcome).toBe("wrong");
		expect(row.answer?.rightPick).toBe(false);
	});

	it("scores 'None of these fit' at 0.95 as left: none fit", () => {
		const row = scoreCase(kase(), ok(jevAnswer(NONE_FIT, 0.95)), NAMES, 120);
		expect(row.outcome).toBe("left: none fit");
	});

	it("scores a confident pick on a case with no right answer as applied", () => {
		const row = scoreCase(
			kase({ rightCategory: null }),
			ok(jevAnswer("Groceries", 0.95)),
			NAMES,
			120,
		);
		expect(row.outcome).toBe("applied");
	});

	it("scores an unsure pick on a case with no right answer as left: unsure", () => {
		const row = scoreCase(
			kase({ rightCategory: null }),
			ok(jevAnswer("Groceries", 0.5)),
			NAMES,
			120,
		);
		expect(row.outcome).toBe("left: unsure");
	});

	it("compares each flag with the seed: hit, false alarm, missed and quiet", () => {
		const row = scoreCase(
			kase({ flags: { transfer: true, reimbursement: true, income: false } }),
			ok(
				jevAnswer("Groceries", 0.95, {
					transfer: 0.9,
					reimbursement: 0.1,
					income: 0.9,
				}),
			),
			NAMES,
			120,
		);
		expect(row.answer?.flags).toEqual({
			transfer: "hit",
			reimbursement: "missed",
			income: "false alarm",
		});
		const quiet = scoreCase(
			kase(),
			ok(jevAnswer("Groceries", 0.95)),
			NAMES,
			120,
		);
		expect(quiet.answer?.flags).toEqual({
			transfer: "quiet",
			reimbursement: "quiet",
			income: "quiet",
		});
	});

	it("reports a flag as set only at the threshold", () => {
		const row = scoreCase(
			kase(),
			ok(jevAnswer("Groceries", 0.95, { income: 0.79 })),
			NAMES,
			120,
		);
		expect(row.answer?.flags.income).toBe("quiet");
	});

	it("keeps whether the answer has a mixed reading and a note", () => {
		const both = scoreCase(
			kase(),
			ok(
				jevAnswer(
					"Groceries",
					0.95,
					{},
					{
						mixed: { probability: 0.2, also: NONE_FIT },
						noteWorthWriting: 0.1,
					},
				),
			),
			NAMES,
			120,
		);
		expect(both.answer?.mixed).toBe(true);
		expect(both.answer?.note).toBe(true);
		const neither = scoreCase(
			kase(),
			ok(jevAnswer("Groceries", 0.95)),
			NAMES,
			120,
		);
		expect(neither.answer?.mixed).toBe(false);
		expect(neither.answer?.note).toBe(false);
	});

	it("marks a failed call with a non-2xx status as failed, with its status", () => {
		const row = scoreCase(
			kase(),
			{ ok: false, status: 429, requestId: null },
			NAMES,
			120,
		);
		expect(row.outcome).toBe("failed: HTTP 429");
		expect(row.answer).toBeNull();
	});

	it("marks a call with no response as failed: no response", () => {
		const row = scoreCase(
			kase(),
			{ ok: false, status: null, requestId: null },
			NAMES,
			120,
		);
		expect(row.outcome).toBe("failed: no response");
	});

	it("marks a 2xx answer that cannot be read as unreadable", () => {
		const row = scoreCase(
			kase(),
			{ ok: false, status: 200, requestId: null },
			NAMES,
			120,
		);
		expect(row.outcome).toBe("unreadable");
	});
});

// ---- Summary -------------------------------------------------------------

describe("summarize", () => {
	const rows: Row[] = [
		scoreCase(
			kase(),
			ok(
				jevAnswer(
					"Groceries",
					0.95,
					{},
					{
						mixed: { probability: 0.2, also: NONE_FIT },
						noteWorthWriting: 0.1,
					},
				),
			),
			NAMES,
			100,
		),
		scoreCase(kase(), ok(jevAnswer("Eating Out", 0.9)), NAMES, 300),
		scoreCase(kase(), ok(jevAnswer("Groceries", 0.7)), NAMES, 200),
		scoreCase(kase(), ok(jevAnswer(NONE_FIT, 0.6)), NAMES, 400),
		scoreCase(
			kase({ rightCategory: null }),
			ok(jevAnswer("Household", 0.85)),
			NAMES,
			500,
		),
		scoreCase(kase(), { ok: false, status: 429, requestId: null }, NAMES, 50),
		scoreCase(kase(), { ok: false, status: 200, requestId: null }, NAMES, 60),
	];
	const summary = summarize(rows);

	it("counts each outcome and the calls that worked", () => {
		expect(summary.worked).toBe(5);
		expect(summary.total).toBe(7);
		expect(summary.right).toBe(1);
		expect(summary.rightPickAnyConfidence).toBe(2);
		expect(summary.wrong).toBe(1);
		expect(summary.leftNoneFit).toBe(1);
		expect(summary.leftUnsure).toBe(1);
		expect(summary.appliedNoRight).toBe(1);
	});

	it("counts flags and mixed-and-note answers", () => {
		expect(summary.flags).toEqual({ hit: 0, falseAlarm: 0, missed: 0 });
		expect(summary.mixedAndNote).toBe(1);
	});

	it("gives the confidence's low, middle and high over the answered calls", () => {
		expect(summary.confidence).toEqual({ low: 0.6, middle: 0.85, high: 0.95 });
	});

	it("gives the middle and slowest ms over every call", () => {
		expect(summary.ms).toEqual({ middle: 200, slowest: 500 });
	});

	it("gives no confidence when no call worked", () => {
		const none = summarize([
			scoreCase(
				kase(),
				{ ok: false, status: null, requestId: null },
				NAMES,
				10,
			),
		]);
		expect(none.confidence).toBeNull();
		expect(none.worked).toBe(0);
	});
});

// ---- Report --------------------------------------------------------------

describe("formatReport", () => {
	const cases = [
		kase({ rawName: "BLUE BOTTLE", rightCategory: "Eating Out" }),
		kase({ rawName: "CHECKCARD 0921 CVS", rightCategory: null }),
	];
	const rowsFor = (answer: JevAnswer | null, outcome: string): Row[] => [
		{
			outcome,
			ms: 120,
			answer: answer
				? scoreCase(cases[0] as Case, ok(answer), NAMES, 120).answer
				: null,
		},
		{ outcome: "failed: HTTP 429", ms: 80, answer: null },
	];
	const report = (
		overrides: Partial<Parameters<typeof formatReport>[0]> = {},
	) =>
		formatReport({
			today: TODAY,
			cases,
			jevStatus: "ran",
			lists: [
				{
					id: "demo",
					title: "The demo's 7 categories",
					categories: NAMES,
					models: [
						{
							name: "Jev",
							rows: rowsFor(jevAnswer("Eating Out", 0.95), "right"),
						},
						{
							name: "Clef",
							rows: rowsFor(jevAnswer("Groceries", 0.79), "left: unsure"),
						},
					],
				},
				{
					id: "fifty",
					title: "The fifty categories",
					categories: NAMES,
					models: [
						{
							name: "Clef",
							rows: rowsFor(jevAnswer("Groceries", 0.95), "applied"),
						},
					],
				},
			],
			notes: [],
			...overrides,
		});

	it("opens with the date, the case count, whether Jev ran, and the two plain sentences", () => {
		const text = report();
		expect(text).toContain(TODAY);
		expect(text).toContain("Cases: 2");
		expect(text).toContain("Jev: ran");
		expect(text).toContain(
			"The demo's rows carry no Plaid category, which real rows do.",
		);
		expect(text).toContain(
			"Times are measured from this machine through wrangler dev.",
		);
	});

	it("has a summary row for each model", () => {
		const text = report();
		expect(text).toMatch(/^\| Jev \|/m);
		expect(text).toMatch(/^\| Clef \|/m);
	});

	it("puts a check on a pick Tally would apply, and not on one it would leave", () => {
		const text = report();
		expect(text).toContain("Eating Out 95.00% ✓");
		expect(text).toContain("Groceries 79.00%");
		expect(text).not.toContain("Groceries 79.00% ✓");
	});

	it("shows a failed call's status", () => {
		expect(report()).toContain("failed: HTTP 429");
	});

	it("says to read the picks on the fifty-list tables only", () => {
		const line =
			"Some of the 50 names fit these stores as well as the demo's own category does, so read the picks, not just the count.";
		const text = report();
		expect(text.split(line).length - 1).toBe(1);
		expect(text.indexOf(line)).toBeGreaterThan(
			text.indexOf("The fifty categories"),
		);
	});

	it("prints each model's first error, unreadable body and usage once", () => {
		const text = report({
			notes: [
				{
					name: "Clef",
					error: "Workers AI is busy",
					unreadable: '{"model":"clef-unique"}',
					usage: { input_tokens: 7 },
				},
			],
		});
		expect(text.split("Workers AI is busy").length - 1).toBe(1);
		expect(text.split('{"model":"clef-unique"}').length - 1).toBe(1);
		expect(text).toContain('"input_tokens": 7');
	});
	it("leaves out a model's heading when it sent back nothing to show", () => {
		const text = report({
			notes: [{ name: "Jev" }, { name: "Clef", usage: { input_tokens: 7 } }],
		});
		expect(text).not.toContain("### Jev");
		expect(text).toContain("### Clef");
	});
});

// ---- Worker --------------------------------------------------------------

describe("Clef through Workers AI", () => {
	it("sends the model's own selector and passes the request's timeout signal", async () => {
		const ai = fakeAi();
		const fetchImpl = viaWorkersAI(ai, CLEF, "clef");
		const response = await fetchImpl(JEV_URL, {
			method: "POST",
			body: JSON.stringify({ model: "jev-latest", state: {}, questions: {} }),
			signal: AbortSignal.timeout(10_000),
		});
		expect(response.status).toBe(200);
		const [model, body, options] = callsOf(ai)[0] ?? [];
		expect(model).toBe(CLEF);
		expect(body?.model).toBe("clef");
		expect(options?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("runComparison", () => {
	const noJev = () =>
		vi.fn(async () => new Response("unused", { status: 500 }));

	it("asks Clef and Clef-flash through Workers AI with their own selectors", async () => {
		const ai = fakeAi();
		await runComparison({ AI: ai }, noJev(), TODAY, {
			lists: ["demo"],
			models: ["clef", "clef-flash"],
		});
		const calls = callsOf(ai);
		const clef = calls.filter(([m]) => m === CLEF);
		const flash = calls.filter(([m]) => m === CLEF_FLASH);
		expect(clef.length).toBe(demoCaseCount);
		expect(flash.length).toBe(demoCaseCount);
		expect(clef.every(([, body]) => body.model === "clef")).toBe(true);
		expect(flash.every(([, body]) => body.model === "clef-flash")).toBe(true);
		expect(
			calls.every(([, , options]) => options.signal instanceof AbortSignal),
		).toBe(true);
	});

	it("asks each model once per case for each list", async () => {
		const ai = fakeAi();
		const jev = vi.fn(async () => Response.json(modelAnswer()));
		await runComparison({ AI: ai, JEV_API_KEY: "test-key" }, jev, TODAY);
		expect(jev).toHaveBeenCalledTimes(2 * demoCaseCount);
		expect(callsOf(ai).filter(([m]) => m === CLEF).length).toBe(
			2 * demoCaseCount,
		);
		expect(callsOf(ai).filter(([m]) => m === CLEF_FLASH).length).toBe(
			2 * demoCaseCount,
		);
	});

	it("sends Jev's request to JEV_URL with the bearer key", async () => {
		const jev = vi.fn(async () => Response.json(modelAnswer()));
		await runComparison({ AI: fakeAi(), JEV_API_KEY: "test-key" }, jev, TODAY, {
			lists: ["demo"],
			models: ["jev"],
		});
		const [url, init] = jev.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(JEV_URL);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer test-key",
		);
	});

	it("skips Jev with no key and still runs Clef", async () => {
		const ai = fakeAi();
		const jev = noJev();
		const text = await runComparison({ AI: ai }, jev, TODAY);
		expect(jev).not.toHaveBeenCalled();
		expect(text).toContain("Jev: skipped, no JEV_API_KEY");
		expect(text).toContain("skipped: no JEV_API_KEY");
		expect(callsOf(ai).filter(([m]) => m === CLEF).length).toBe(
			2 * demoCaseCount,
		);
	});

	it("shows a Clef call that throws as failed: no response, with its message once", async () => {
		const ai = fakeAi((model, body) => {
			if (model === CLEF) throw new Error("Workers AI is busy");
			return { ...modelAnswer(), model: body.model };
		});
		const text = await runComparison({ AI: ai }, noJev(), TODAY, {
			lists: ["demo"],
			models: ["clef"],
		});
		expect(text).toContain("failed: no response");
		expect(text.split("Workers AI is busy").length - 1).toBe(1);
	});

	it("shows a 2xx answer that cannot be read as unreadable, with its raw body once", async () => {
		const ai = fakeAi((model) =>
			model === CLEF ? { model: "clef" } : modelAnswer(),
		);
		const text = await runComparison({ AI: ai }, noJev(), TODAY, {
			lists: ["demo"],
			models: ["clef"],
		});
		expect(text).toContain("unreadable");
		expect(text.split('{"model":"clef"}').length - 1).toBe(1);
	});
});

describe("the Worker's routes", () => {
	it("runs only the asked-for model and list for ?model=clef&list=demo", async () => {
		const ai = fakeAi();
		const response = await worker.fetch(
			new Request("https://compare.test/?model=clef&list=demo"),
			{ AI: ai },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/markdown");
		const calls = callsOf(ai);
		expect(calls.every(([m]) => m === CLEF)).toBe(true);
		expect(calls.length).toBe(demoCaseCount);
	});

	it("answers any other path with a 404 and makes no call", async () => {
		const ai = fakeAi();
		const response = await worker.fetch(
			new Request("https://compare.test/favicon.ico"),
			{ AI: ai },
		);
		expect(response.status).toBe(404);
		expect(ai.run).not.toHaveBeenCalled();
	});

	it("answers an unknown model or list with a 400 and makes no call", async () => {
		const ai = fakeAi();
		const response = await worker.fetch(
			new Request("https://compare.test/?model=gpt"),
			{ AI: ai },
		);
		expect(response.status).toBe(400);
		expect(ai.run).not.toHaveBeenCalled();
	});
});
