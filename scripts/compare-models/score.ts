// Turns the demo seed into the cases the comparison asks about, and scores each answer the way Tally would
// store it: `decide` at JEV_THRESHOLD (spec §7). Pure: no network, no clock.
import {
	JEV_THRESHOLD,
	type JevInput,
	type JevResult,
} from "../../src/ai/categorize";
import { decide, type Flag } from "../../src/ai/decide";
import type { Seed, SeedTransaction } from "../../src/demo/seed";

export type Direction = "money out" | "money in";

/** One case: a raw name and a direction, as a new family's first sync would see it. */
export type Case = {
	rawName: string;
	direction: Direction;
	/** Tally's input, from the case's first row. Nothing else is sent: no history, note, kind or person. */
	input: JevInput;
	/** The first category any row of the case has, or null when a person decides. */
	rightCategory: string | null;
	/** The seed's flags, from the case's first row (every row of a case agrees). */
	flags: Record<Flag, boolean>;
};

/** Money out is Plaid's positive amount (CLAUDE.md). */
const directionOf = (amountCents: number): Direction =>
	amountCents >= 0 ? "money out" : "money in";

/**
 * The seed's rows, one case per raw name and direction. Split parts and parents and cash rows are skipped:
 * a new family's Plaid rows never include them. A case takes its input from its first row in array order,
 * and its right answer from the first category any of its rows has.
 */
export function buildCases(seed: Seed): Case[] {
	const cash = new Set(
		seed.accounts.filter((a) => a.type === "cash").map((a) => a.id),
	);
	const cases = new Map<
		string,
		{ first: SeedTransaction; rightCategoryId: number | null }
	>();
	for (const t of seed.transactions) {
		if (t.parentId != null || t.isSplit || cash.has(t.accountId)) continue;
		const key = `${t.rawName}\n${directionOf(t.amountCents)}`;
		const seen = cases.get(key);
		if (!seen) {
			cases.set(key, { first: t, rightCategoryId: t.categoryId });
		} else if (seen.rightCategoryId === null) {
			seen.rightCategoryId = t.categoryId;
		}
	}
	return [...cases.values()].map(({ first, rightCategoryId }) => ({
		rawName: first.rawName,
		direction: directionOf(first.amountCents),
		input: {
			rawName: first.rawName,
			displayName: first.merchantName ?? null,
			amountCents: first.amountCents,
			accountType:
				seed.accounts.find((a) => a.id === first.accountId)?.type ?? "unknown",
		},
		rightCategory:
			seed.categories.find((c) => c.id === rightCategoryId)?.name ?? null,
		flags: {
			transfer: first.flagTransfer,
			reimbursement: first.flagReimbursement,
			income: first.flagIncome,
		},
	}));
}

/** The demo's own categories, in their sort order. */
export function demoCategories(seed: Seed): string[] {
	return [...seed.categories]
		.sort((a, b) => a.sortOrder - b.sortOrder)
		.map((c) => c.name);
}

/** The nine starting categories (migrations/0005_default_categories.sql) that the demo doesn't have. */
const STARTING_NOT_IN_DEMO = [
	"Car & Transport",
	"Utilities",
	"Subscriptions",
	"Shopping",
	"Personal Care",
	"Health",
	"Entertainment",
	"Date Night",
	"Donations & Charity",
];

/** Thirty-four more of the most a household may have (decision 37), so the list reaches fifty. */
const MORE_CATEGORIES = [
	"Phone",
	"Internet",
	"Streaming",
	"Gym",
	"Doctor",
	"Dentist",
	"Pharmacy",
	"Health Insurance",
	"Car Insurance",
	"Home Insurance",
	"Car Payment",
	"Car Repair",
	"Parking",
	"Tolls",
	"Public Transit",
	"Rideshare",
	"Travel",
	"Hotels",
	"Flights",
	"Clothing",
	"Shoes",
	"Gifts",
	"Pets",
	"Vet",
	"Hobbies",
	"Crafts",
	"Books",
	"Electronics",
	"Home Repair",
	"Garden",
	"Furniture",
	"Bank Fees",
	"Taxes",
	"Allowance",
];

/** The demo's seven, then the nine starting ones, then the thirty-four: fifty names in all. */
export function fiftyCategories(seed: Seed): string[] {
	return [...demoCategories(seed), ...STARTING_NOT_IN_DEMO, ...MORE_CATEGORIES];
}

export type FlagOutcome = "hit" | "false alarm" | "missed" | "quiet";

/** What a model answered for a case that Tally would read. */
export type Answered = {
	/** Jev's category label, or NONE_FIT ("None of these fit"). */
	pick: string;
	confidence: number;
	/** Tally would store this category. */
	applied: boolean;
	/** The pick is the demo's right answer, applied or not. */
	rightPick: boolean;
	/** Each flag against the seed's, using the flags Tally would set. */
	flags: Record<Flag, FlagOutcome>;
	mixed: boolean;
	note: boolean;
};

export type Row = {
	outcome: string;
	ms: number;
	answer: Answered | null;
};

export const SKIPPED_OUTCOME = "skipped: no JEV_API_KEY";

/** A row for a model that wasn't asked: no key, so no call. */
export const skippedRow = (): Row => ({
	outcome: SKIPPED_OUTCOME,
	ms: 0,
	answer: null,
});

const failedOutcome = (status: number | null): string => {
	if (status === null) return "failed: no response";
	if (status >= 200 && status < 300) return "unreadable";
	return `failed: HTTP ${status}`;
};

const flagOutcome = (set: boolean, truth: boolean): FlagOutcome => {
	if (set) return truth ? "hit" : "false alarm";
	return truth ? "missed" : "quiet";
};

/**
 * One case's outcome. With a right answer: right, wrong, or left (none fit or unsure). Without one: applied, or
 * left. A failed call is failed (with its status), no response, or unreadable.
 */
export function scoreCase(
	kase: Case,
	result: JevResult,
	categories: string[],
	ms: number,
): Row {
	if (!result.ok) {
		return { outcome: failedOutcome(result.status), ms, answer: null };
	}
	const { answer } = result;
	const decision = decide(
		answer,
		categories.map((name, i) => ({ id: i + 1, name })),
		JEV_THRESHOLD,
	);
	const appliedName =
		decision.categoryId === null
			? null
			: (categories[decision.categoryId - 1] ?? null);
	const applied = appliedName !== null;
	const right = kase.rightCategory;
	const left = decision.noneFit ? "left: none fit" : "left: unsure";
	let outcome: string;
	if (right === null) outcome = applied ? "applied" : left;
	else if (!applied) outcome = left;
	else outcome = appliedName === right ? "right" : "wrong";
	return {
		outcome,
		ms,
		answer: {
			pick: answer.category.label,
			confidence: answer.category.confidence,
			applied,
			rightPick: right !== null && answer.category.label === right,
			flags: {
				transfer: flagOutcome(decision.flags.transfer, kase.flags.transfer),
				reimbursement: flagOutcome(
					decision.flags.reimbursement,
					kase.flags.reimbursement,
				),
				income: flagOutcome(decision.flags.income, kase.flags.income),
			},
			mixed: answer.mixed !== undefined,
			note: answer.noteWorthWriting !== undefined,
		},
	};
}

export type Summary = {
	/** Calls that came back readable. */
	worked: number;
	total: number;
	right: number;
	rightPickAnyConfidence: number;
	wrong: number;
	leftNoneFit: number;
	leftUnsure: number;
	appliedNoRight: number;
	flags: { hit: number; falseAlarm: number; missed: number };
	mixedAndNote: number;
	confidence: { low: number; middle: number; high: number } | null;
	ms: { middle: number; slowest: number } | null;
};

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const half = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[half] ?? 0;
	return ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
}

/** One model's rows for one list, counted. Skipped rows make no call, so their time is left out. */
export function summarize(rows: Row[]): Summary {
	const answered = rows.flatMap((r) => (r.answer ? [r.answer] : []));
	const count = (outcome: string) =>
		rows.filter((r) => r.outcome === outcome).length;
	const flagOutcomes = answered.flatMap((a) => Object.values(a.flags));
	const confidences = answered.map((a) => a.confidence);
	const times = rows
		.filter((r) => r.outcome !== SKIPPED_OUTCOME)
		.map((r) => r.ms);
	return {
		worked: answered.length,
		total: rows.length,
		right: count("right"),
		rightPickAnyConfidence: answered.filter((a) => a.rightPick).length,
		wrong: count("wrong"),
		leftNoneFit: count("left: none fit"),
		leftUnsure: count("left: unsure"),
		appliedNoRight: count("applied"),
		flags: {
			hit: flagOutcomes.filter((o) => o === "hit").length,
			falseAlarm: flagOutcomes.filter((o) => o === "false alarm").length,
			missed: flagOutcomes.filter((o) => o === "missed").length,
		},
		mixedAndNote: answered.filter((a) => a.mixed && a.note).length,
		confidence:
			confidences.length > 0
				? {
						low: Math.min(...confidences),
						middle: median(confidences),
						high: Math.max(...confidences),
					}
				: null,
		ms:
			times.length > 0
				? { middle: median(times), slowest: Math.max(...times) }
				: null,
	};
}
