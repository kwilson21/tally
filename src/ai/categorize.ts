// The only place Tally talks to Jev (CLAUDE.md, spec §7): one plain fetch per transaction,
// asking the category and every flag together. It returns Jev's answers and decides nothing.
import { type Flag, type JevAnswer, NONE_FIT } from "./decide";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** One threshold for the category's confidence and each flag's probability (spec §7). */
export const JEV_THRESHOLD = 0.8;

const TIMEOUT_MS = 10_000;

/**
 * What Jev is told about a transaction; nothing else (no dates or account names). A note a person wrote
 * is told too (spec §7, decision 64), so it can help the transaction sort.
 */
export type JevInput = {
	rawName: string;
	displayName: string | null;
	/** Plaid's sign convention: positive is money out. */
	amountCents: number;
	accountType: string;
	plaidCategory?: string | null;
	note?: string | null;
	kind?: string | null;
	forPerson?: string | null;
	/** The merchant's five most recent trips, each with distinct chosen categories in split-part order. */
	merchantCategoryHistory?: string[][];
};

export type JevResult =
	| { ok: true; answer: JevAnswer }
	/** status is null when no response arrived (network error or timeout). */
	| { ok: false; status: number | null; requestId: string | null };

const FLAG_QUESTIONS: Record<Flag, string> = {
	transfer:
		"Is this a transfer between the household's own accounts, rather than spending?",
	reimbursement:
		"Is this money paid back to the household for an earlier expense, such as a reimbursement?",
	income: "Is this income, such as pay, a salary, or interest?",
};

export async function askJev(
	input: JevInput,
	categories: string[],
	apiKey: string,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
	options: { details?: boolean; people?: { id: number; name: string }[] } = {},
): Promise<JevResult> {
	const categoryInstructions = [
		"Which of this household's budget categories does this bank transaction belong to?",
		...(input.merchantCategoryHistory?.length
			? [
					"The state includes this merchant's recent categories chosen by a person or a merchant rule; use them as context for this category guess.",
				]
			: []),
	].join(" ");
	const body = {
		model: "jev-latest",
		state: {
			bank_description: input.rawName,
			merchant: input.displayName,
			amount_cents: Math.abs(input.amountCents),
			direction: input.amountCents >= 0 ? "money out" : "money in",
			account_type: input.accountType,
			...(input.plaidCategory ? { plaid_category: input.plaidCategory } : {}),
			...(input.note ? { note: input.note } : {}),
			...(input.kind ? { kind: input.kind } : {}),
			...(input.forPerson ? { for_person: input.forPerson } : {}),
			...(input.merchantCategoryHistory?.length
				? { merchant_category_history: input.merchantCategoryHistory }
				: {}),
		},
		questions: {
			...(categories.length > 0
				? {
						category: {
							type: "choice",
							instructions: categoryInstructions,
							criteria: {
								...Object.fromEntries(categories.map((name) => [name, null])),
								[NONE_FIT]:
									"None of these categories fits this transaction, so a person should decide.",
							},
						},
					}
				: {}),
			...Object.fromEntries(
				Object.entries(FLAG_QUESTIONS).map(([flag, instructions]) => [
					flag,
					{ type: "noul", instructions },
				]),
			),
			...(options.details
				? {
						kind: {
							type: "choice",
							instructions:
								"What kind of spending is this purchase? Choose one, or None of these.",
							criteria: Object.fromEntries([
								["subscription", "A repeating subscription or membership."],
								["one_off", "A one-off purchase."],
								[
									"bill",
									"A household bill; this label never creates or pays a bill.",
								],
								[
									"transfer",
									"A transfer; this label never changes the amount or excludes it.",
								],
								["None of these", "The kind isn't clear."],
							]),
						},
						for_person: {
							type: "choice",
							instructions:
								"Who was this purchase for? Choose the household person's id, or none if it is unclear.",
							criteria: Object.fromEntries([
								...(options.people ?? []).map((person) => [
									`person:${person.id}`,
									person.name,
								]),
								["none", "It isn't clear who this was for."],
							]),
						},
					}
				: {}),
		},
	};

	let response: Response;
	try {
		response = await fetchImpl(JEV_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { ok: false, status: null, requestId: null };
	}

	const requestId = response.headers.get("x-typesafe-request-id");
	if (!response.ok) return { ok: false, status: response.status, requestId };

	const answer = parseAnswer(
		await response.json().catch(() => null),
		categories.length ? [...categories, NONE_FIT] : [],
		options.details
			? ["subscription", "one_off", "bill", "transfer", "None of these"]
			: [],
		options.people
			? [...options.people.map((person) => `person:${person.id}`), "none"]
			: [],
	);
	return answer
		? { ok: true, answer }
		: { ok: false, status: response.status, requestId };
}

/**
 * Reads the answers Jev documents: a choice with a confidence, and a yes-probability per flag.
 * A choice that wasn't one of the options offered is malformed, so it's never stored and can't
 * be mistaken for "None of these fit".
 */
function parseAnswer(
	data: unknown,
	options: string[],
	kinds: string[],
	people: string[],
): JevAnswer | null {
	const answers = (data as { answers?: Record<string, unknown> } | null)
		?.answers;
	const category = answers?.category as
		| { choice?: unknown; confidence?: unknown }
		| undefined;
	if (
		category &&
		(typeof category.choice !== "string" ||
			!options.includes(category.choice) ||
			!isProbability(category.confidence))
	) {
		return null;
	}
	if (!category && options.length > 0) return null;
	const flags = {} as Record<Flag, number>;
	for (const flag of Object.keys(FLAG_QUESTIONS) as Flag[]) {
		const noul = (answers?.[flag] as { noul?: unknown } | undefined)?.noul;
		if (!isProbability(noul)) return null;
		flags[flag] = noul;
	}
	const choice = (key: string, allowed: string[]) => {
		const item = answers?.[key] as
			| { choice?: unknown; confidence?: unknown }
			| undefined;
		if (!item) return undefined;
		return typeof item.choice === "string" &&
			allowed.includes(item.choice) &&
			isProbability(item.confidence)
			? { label: item.choice, confidence: item.confidence }
			: undefined;
	};
	const kind = choice("kind", kinds);
	const forPerson = choice("for_person", people);
	if (kinds.length && !kind) return null;
	if (people.length && !forPerson) return null;
	return {
		category: category
			? {
					label: category.choice as string,
					confidence: category.confidence as number,
				}
			: { label: NONE_FIT, confidence: 0 },
		flags,
		...(kind ? { kind } : {}),
		...(forPerson ? { forPerson } : {}),
	};
}

const isProbability = (n: unknown): n is number =>
	typeof n === "number" && n >= 0 && n <= 1;
