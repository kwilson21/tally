// The only place Tally talks to Jev (CLAUDE.md, spec §7): one plain fetch per transaction,
// asking the category and every flag together. It returns Jev's answers and decides nothing.
import { type Flag, type JevAnswer, NONE_FIT } from "./decide";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** One threshold for the category's confidence and each flag's probability (spec §7). */
export const JEV_THRESHOLD = 0.8;

const TIMEOUT_MS = 10_000;

/** What Jev is told about a transaction; nothing else (no dates, notes or account names). */
export type JevInput = {
	rawName: string;
	displayName: string | null;
	/** Plaid's sign convention: positive is money out. */
	amountCents: number;
	accountType: string;
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
): Promise<JevResult> {
	const body = {
		model: "jev-latest",
		state: {
			bank_description: input.rawName,
			merchant: input.displayName,
			amount_cents: Math.abs(input.amountCents),
			direction: input.amountCents >= 0 ? "money out" : "money in",
			account_type: input.accountType,
		},
		questions: {
			category: {
				type: "choice",
				instructions:
					"Which of this household's budget categories does this bank transaction belong to?",
				criteria: {
					...Object.fromEntries(categories.map((name) => [name, null])),
					[NONE_FIT]:
						"None of these categories fits this transaction, so a person should decide.",
				},
			},
			...Object.fromEntries(
				Object.entries(FLAG_QUESTIONS).map(([flag, instructions]) => [
					flag,
					{ type: "noul", instructions },
				]),
			),
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

	const answer = parseAnswer(await response.json().catch(() => null), [
		...categories,
		NONE_FIT,
	]);
	return answer
		? { ok: true, answer }
		: { ok: false, status: response.status, requestId };
}

/**
 * Reads the answers Jev documents: a choice with a confidence, and a yes-probability per flag.
 * A choice that wasn't one of the options offered is malformed, so it's never stored and can't
 * be mistaken for "None of these fit".
 */
function parseAnswer(data: unknown, options: string[]): JevAnswer | null {
	const answers = (data as { answers?: Record<string, unknown> } | null)
		?.answers;
	const category = answers?.category as
		| { choice?: unknown; confidence?: unknown }
		| undefined;
	if (
		typeof category?.choice !== "string" ||
		!options.includes(category.choice) ||
		!isProbability(category.confidence)
	) {
		return null;
	}
	const flags = {} as Record<Flag, number>;
	for (const flag of Object.keys(FLAG_QUESTIONS) as Flag[]) {
		const noul = (answers?.[flag] as { noul?: unknown } | undefined)?.noul;
		if (!isProbability(noul)) return null;
		flags[flag] = noul;
	}
	return {
		category: { label: category.choice, confidence: category.confidence },
		flags,
	};
}

const isProbability = (n: unknown): n is number =>
	typeof n === "number" && n >= 0 && n <= 1;
