// Measures candidate Workers AI models at Tally's merchant-name suggestion (spec §7), because the model it
// uses today (Llama 3.1 8B fp8) is deprecated on Nov 20, 2026. It asks each model exactly what production
// asks (`INSTRUCTIONS`, the same messages, the same limits), runs each answer through production's own name
// check (`cleanSuggestedNames`), and returns a markdown report to read side by side. It decides nothing: a
// person reads the names. Never deploy it: it bills Workers AI. Only bank texts are sent, no amounts or
// dates, as in production. It needs `pnpm exec wrangler login`. Run it locally:
//   pnpm exec wrangler dev --config scripts/compare-names/wrangler.jsonc --port 8798
//   curl -s http://localhost:8798/ > report.md
// Add ?models=granite,gemma4 (see CANDIDATES), ?limit=20 (first N texts) or ?tokens=400 (the answer budget;
// production uses 60) to run a slice. ?task=notes or ?task=categories asks the same models production's other two
// prompts (the "what it was" note, and a category name for a purchase), which share the name model.
import {
	cleanSuggestedNames,
	INSTRUCTIONS,
	suggestCategoryName,
	suggestNote,
} from "../../src/ai/suggest-name";
import { cleanBankText } from "../../src/clean-bank-text";
import { DEFAULT_TIME_ZONE, todayIn } from "../../src/dates";
import { buildSeed, type Seed } from "../../src/demo/seed";
import { tidyName } from "../../src/transactions/tidy-name";
import { demoCategories } from "../compare-models/score";

export type CompareEnv = { AI: Ai };

/** The models to measure; the key is what `?models=` takes. `baseline` is what production runs today. */
export const CANDIDATES = {
	llama: {
		label: "Llama 3.1 8B fp8 (today's, baseline)",
		id: "@cf/meta/llama-3.1-8b-instruct-fp8",
	},
	granite: {
		label: "Granite 4.0 H Micro",
		id: "@cf/ibm-granite/granite-4.0-h-micro",
	},
	"mistral-small": {
		label: "Mistral Small 3.1 24B",
		id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
	},
	"llama4-scout": {
		label: "Llama 4 Scout 17B",
		id: "@cf/meta/llama-4-scout-17b-16e-instruct",
	},
	gemma4: {
		label: "Gemma 4 26B",
		id: "@cf/google/gemma-4-26b-a4b-it",
	},
	"glm-flash": {
		label: "GLM 4.7 Flash",
		id: "@cf/zai-org/glm-4.7-flash",
	},
	"gpt-oss": {
		label: "gpt-oss 20B",
		id: "@cf/openai/gpt-oss-20b",
	},
} as const;

export type CandidateKey = keyof typeof CANDIDATES;

// SAFETY: CANDIDATES is one literal object, so Object.keys lists exactly its own keys, each a CandidateKey.
const KEYS = Object.keys(CANDIDATES) as CandidateKey[];

/** Whether `value` is one of the models `?models=` may name (the same test as KEYS.includes). */
const isCandidateKey = (value: string): value is CandidateKey =>
	KEYS.some((key) => key === value);

/** What production allows an answer (suggest-name.ts): the default budget to compare against. */
const PRODUCTION_TOKENS = 60;

/** Production's own limit (suggest-name.ts): a model slower than this is unusable there, so it fails here too. */
const TIMEOUT_MS = 15_000;

/** Messy bank texts of the kind a real statement prints, to add to the seed's few clean ones. */
const EXTRA_TEXTS = [
	"AMZN MKTP US*2K4XY91Q0",
	"SQ *BLUE BOTTLE COFFEE 0231",
	"TST* JOES PIZZA - BROOKLYN",
	"PAYPAL *SPOTIFYUSA 402-935-7733",
	"WM SUPERCENTER #1234",
	"SHELL OIL 57444297301",
	"UBER *TRIP HELP.UBER.COM",
	"APPLE.COM/BILL 866-712-7753",
	"TRADER JOE S #552",
	"CHICK-FIL-A #01234",
	"DD *DOORDASH MCDONALDS",
	"COSTCO WHSE #0421",
	"GOOGLE *YOUTUBE PREMIUM",
	"VENMO PAYMENT 1234567",
	"CVS/PHARMACY #08712",
	"LYFT *RIDE SAT 8PM",
	"KROGER FUEL CTR 0043",
	"PP*ETSY INC",
	"H-E-B #402",
	"SP HARRYS",
	"WHOLEFDS MKT 10234",
	"T-MOBILE*AUTO PAY",
	"BP#8812345HIGHWAY 9",
	"POS DEBIT 4821 LOCAL HARDWARE & SUPPLY",
	"CHECKCARD 1105 STARBUCKS STORE 08812",
];

/** The seed's bank texts, then the extras, each once, optionally only the first `limit`. */
export function bankTexts(seed: Seed, limit?: number): string[] {
	const all = [
		...seed.transactions.map((transaction) => transaction.rawName),
		...EXTRA_TEXTS,
	].flatMap((text) => {
		const trimmed = text.trim();

		return trimmed ? [trimmed] : [];
	});

	const unique = [...new Set(all)];

	return limit === undefined ? unique : unique.slice(0, limit);
}

export type Reply = {
	text: string | null;
	/** `response` (Llama, Granite), `chat` (Gemma, GLM) or `responses` (gpt-oss): the three shapes seen. */
	form: "response" | "chat" | "responses" | "unknown";
	finish?: string;
	/** The model sent thinking but no answer, so it ran out of tokens before replying. */
	thoughtOnly?: boolean;
	/** There is text, but the API says the model was stopped at the token limit, so the answer is partial. */
	truncated?: boolean;
};

/** Any JSON value: a model's answer once it has been read from the response. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const isText = (value: Json | undefined): value is string =>
	typeof value === "string";

/** A JSON object; an array counts too, as it did when fields were read off the answer directly. */
const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
	typeof value === "object" && value !== null;

/** A field of a JSON object, or undefined when the value has no fields (a string, a number, null). */
const fieldOf = (value: Json | undefined, key: string): Json | undefined =>
	isObject(value) ? value[key] : undefined;

const nonEmpty = (value: Json | undefined): string | null =>
	isText(value) && value.trim() ? value : null;

/** The answer's text from any of the shapes Workers AI text models return, and how it was shaped. */
export function replyOf(answer: Json | ReadableStream): Reply {
	// A stream has no text to read; askNames never asks for one, so this is only the type's other member.
	if (answer instanceof ReadableStream) return { text: null, form: "unknown" };

	if (isText(answer)) return { text: nonEmpty(answer), form: "response" };

	if (!isObject(answer)) return { text: null, form: "unknown" };

	if (isText(answer.response))
		return { text: nonEmpty(answer.response), form: "response" };

	const choice = Array.isArray(answer.choices) ? answer.choices[0] : undefined;

	if (choice) {
		const message = fieldOf(choice, "message");
		const text = nonEmpty(fieldOf(message, "content"));

		const rawFinish = fieldOf(choice, "finish_reason");
		const finish = isText(rawFinish) ? rawFinish : undefined;

		const thought =
			nonEmpty(fieldOf(message, "reasoning_content")) ??
			nonEmpty(fieldOf(message, "reasoning"));

		const reply: Reply = { text, form: "chat", finish };

		if (text === null && thought !== null && finish === "length")
			reply.thoughtOnly = true;

		if (text !== null && finish === "length") reply.truncated = true;

		return reply;
	}

	if (isText(answer.output_text) || Array.isArray(answer.output)) {
		const rawItems = answer.output;
		const items: Json[] = Array.isArray(rawItems) ? rawItems : [];

		const parts = items.flatMap((item) => {
			if (fieldOf(item, "type") !== "message") return [];

			const content = fieldOf(item, "content");

			if (!Array.isArray(content)) return [];

			return content.flatMap((part) => {
				const text = nonEmpty(fieldOf(part, "text"));

				return text === null ? [] : [text];
			});
		});

		const text = nonEmpty(answer.output_text) ?? (parts.join("\n") || null);

		const incomplete = fieldOf(answer.incomplete_details, "reason");

		const thoughtOnly =
			text === null &&
			incomplete === "max_output_tokens" &&
			items.some((item) => fieldOf(item, "type") === "reasoning");

		const reply: Reply = { text, form: "responses" };

		if (thoughtOnly) reply.thoughtOnly = thoughtOnly;

		if (text !== null && incomplete === "max_output_tokens")
			reply.truncated = true;

		return reply;
	}

	return { text: null, form: "unknown" };
}

export type NameResult = {
	text: string;
	ok: boolean;
	/** The names production would offer. Empty when the model answered but nothing passed the name check. */
	names?: string[];
	error?: string;
	thoughtOnly?: boolean;
	/** Cut off at the token limit with some text, so the names may be partial. */
	truncated?: boolean;
	ms: number;
	form: Reply["form"];
	finish?: string;
};

/** One model, one bank text: production's messages and limits, with the answer budget `tokens`. */
export async function askNames(
	ai: Ai,
	modelId: string,
	text: string,
	tokens: number,
): Promise<NameResult> {
	const started = Date.now();

	try {
		// SAFETY: runNamesComparison passes askNames only CANDIDATES ids, which the CANDIDATES test checks are catalog models, so
		// modelId is typed as a key of AiModels; the `as` only types the string for ai.run. The body is production's request (suggest-name.ts), and no one input type covers every catalog model, so it is `never`.
		const answer = await ai.run(
			modelId as keyof AiModels,
			{
				messages: [
					{ role: "system", content: INSTRUCTIONS },
					{ role: "user", content: `Bank text: ${text}` },
				],
				max_tokens: tokens,
				temperature: 0.2,
			} as never,
			{ signal: AbortSignal.timeout(TIMEOUT_MS) },
		);

		const reply = replyOf(answer);
		const ms = Date.now() - started;

		if (reply.text === null)
			return {
				text,
				ok: false,
				ms,
				form: reply.form,
				finish: reply.finish,
				thoughtOnly: reply.thoughtOnly,
			};

		return {
			text,
			ok: true,
			names: cleanSuggestedNames(reply.text, text),
			ms,
			form: reply.form,
			finish: reply.finish,
			truncated: reply.truncated,
		};
	} catch (error) {
		return {
			text,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			ms: Date.now() - started,
			form: "unknown",
		};
	}
}

/** What a run asks: the name prompt, the "what it was" note, or a category name for a purchase. */
export type Task = "names" | "notes" | "categories";

const TASKS: Task[] = ["names", "notes", "categories"];

/** Whether `value` is one of the tasks `?task=` may name (the same test as TASKS.includes). */
const isTask = (value: string): value is Task =>
	TASKS.some((task) => task === value);

// SAFETY: runNamesComparison passes askOther only CANDIDATES ids, which the CANDIDATES test checks are catalog models, so
// modelId is a key of AiModels; the object has only `run`, the one member suggestNote and suggestCategoryName call (src/ai/suggest-name.ts).
/**
 * An Ai that asks `modelId` wherever production's code asks for NAME_MODEL, so production's own note and
 * category-name functions run unchanged (their prompts are not copied here) against a candidate.
 */
const withModel = (ai: Ai, modelId: string): Ai =>
	({
		run: (_model: string, body: never, options?: never) =>
			ai.run(modelId as keyof AiModels, body, options),
	}) as Ai;

/**
 * One model, one bank text, through production's note prompt (suggestNote) or its per-purchase category-name
 * prompt (suggestCategoryName: the bank text and the family's categories, decisions 164 and 165). These
 * functions keep why an answer failed to themselves, so a failure shows only that it failed.
 */
export async function askOther(
	task: Exclude<Task, "names">,
	ai: Ai,
	modelId: string,
	text: string,
	categories: string[],
): Promise<NameResult> {
	const started = Date.now();
	const candidate = withModel(ai, modelId);

	const value =
		task === "notes"
			? await suggestNote(candidate, text).then((r) =>
					r.ok ? { ok: true as const, value: r.note } : { ok: false as const },
				)
			: await suggestCategoryName(
					candidate,
					[tidyName(text) || text],
					// Names to avoid: none. Production lists only archived categories and dismissed suggestions here
					// (purchaseNamesToAvoid), and gives the active ones as choices, so the fixtures have nothing to avoid.
					[],
					// The bank text as production sends it: cleaned first (cleanBankText), as suggestedCategoryName does.
					cleanBankText(text),
					categories,
				).then((r) =>
					r.ok ? { ok: true as const, value: r.name } : { ok: false as const },
				);

	const ms = Date.now() - started;

	if (!value.ok)
		return {
			text,
			ok: false,
			error: "no usable answer (the Worker's log has the error's name)",
			ms,
			form: "unknown",
		};

	return {
		text,
		ok: true,
		names: value.value ? [value.value] : [],
		ms,
		form: "unknown",
	};
}

export type Slice = {
	models?: string[];
	limit?: number;
	tokens?: number;
	task?: string;
};

/** Every chosen model over every text, one call at a time with no retries, as a markdown report. */
export async function runNamesComparison(
	env: CompareEnv,
	slice: Slice = {},
	today: string = todayIn(DEFAULT_TIME_ZONE),
): Promise<string> {
	const chosen: string[] = slice.models ?? KEYS;
	const unknown = chosen.filter((key) => !isCandidateKey(key));

	if (unknown.length > 0)
		throw new Error(
			`Unknown model ${unknown.join(", ")}. Choose from ${KEYS.join(", ")}.`,
		);
	const keys = chosen.filter(isCandidateKey);
	const task: string = slice.task ?? "names";

	if (!isTask(task))
		throw new Error(`Unknown task ${task}. Choose from ${TASKS.join(", ")}.`);
	const tokens = slice.tokens ?? PRODUCTION_TOKENS;
	const seed = buildSeed(today);
	const texts = bankTexts(seed, slice.limit);
	const categories = demoCategories(seed);
	const models: ReportModel[] = [];

	for (const key of keys) {
		const results: NameResult[] = [];

		for (const text of texts) {
			results.push(
				task === "names"
					? await askNames(env.AI, CANDIDATES[key].id, text, tokens)
					: await askOther(task, env.AI, CANDIDATES[key].id, text, categories),
			);
		}

		console.log(`compare-names ${key} done`);
		models.push({ key, results });
	}

	return formatNamesReport({ today, tokens, models, task });
}

export type ReportModel = { key: string; results: NameResult[] };

export type ReportInput = {
	today: string;
	tokens: number;
	models: ReportModel[];
	/** Which prompt was asked; names when left out. */
	task?: Task;
};

const HEADINGS: Record<Task, string> = {
	names: "# Merchant-name model comparison",
	notes: "# Purchase-note model comparison",
	categories: "# Category-name model comparison",
};

const cell = (value: string) =>
	value.replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** What a result shows in the side-by-side table. */
function show(result: NameResult | undefined): string {
	if (!result) return "—";

	if (result.error) return cell(`⚠ ${result.error}`);

	if (result.thoughtOnly) return "⚠ ran out of tokens while thinking";

	if (!result.ok) return "⚠ no text in the answer";

	if (!result.names || result.names.length === 0)
		return "(nothing passed the name check)";
	const names = cell(result.names.join(" / "));

	return result.truncated ? `${names} ⚠ cut off at the token limit` : names;
}

/** The summary table, then every bank text with each model's names beside it. */
export function formatNamesReport(input: ReportInput): string {
	const candidateOf = (key: string) =>
		isCandidateKey(key) ? CANDIDATES[key] : undefined;

	const label = (key: string) => candidateOf(key)?.label ?? key;

	const idOf = (key: string) => candidateOf(key)?.id ?? key;

	const lines = [
		HEADINGS[input.task ?? "names"],
		"",
		input.task && input.task !== "names"
			? `Run on ${input.today}. Production's own prompt and limits are used for this task (\`?tokens\` is ignored), and each answer is what production would keep after its own checks, so "named" counts texts with an answer that passed. The two token columns are always 0 here: production's function keeps the reason an answer was unusable to itself, so a failure shows only that it failed.`
			: `Run on ${input.today}. Answer budget: ${input.tokens} tokens (production allows ${PRODUCTION_TOKENS}). Names are what production would offer after its own name check, so "named" counts texts with at least one name that passed.`,
		"",
		"| Model | Id | Texts | Named | Empty after check | Failed | Ran out of tokens | Cut off mid-answer | Avg ms |",
		"|---|---|---|---|---|---|---|---|---|",
	];

	for (const { key, results } of input.models) {
		const named = results.filter(
			(r) => r.ok && (r.names?.length ?? 0) > 0,
		).length;

		const empty = results.filter(
			(r) => r.ok && (r.names?.length ?? 0) === 0,
		).length;

		const failed = results.filter((r) => !r.ok && !r.thoughtOnly).length;
		const thought = results.filter((r) => r.thoughtOnly).length;
		const cutOff = results.filter((r) => r.truncated).length;

		const avg = results.length
			? Math.round(results.reduce((sum, r) => sum + r.ms, 0) / results.length)
			: 0;

		lines.push(
			`| ${label(key)} | ${idOf(key)} | ${results.length} | ${named} | ${empty} | ${failed} | ${thought} | ${cutOff} | ${avg} |`,
		);
	}

	const forms = input.models.map(
		({ key, results }) =>
			`- ${label(key)}: ${[...new Set(results.map((r) => r.form))].join(", ")}`,
	);

	const isNames = (input.task ?? "names") === "names";

	if (isNames) lines.push("", "Answer shapes seen:", ...forms);

	const noFinish = input.models
		.filter(({ results }) => results.some((r) => r.form === "response"))
		.map(({ key }) => label(key));

	if (isNames && noFinish.length > 0)
		lines.push(
			"",
			`The \`response\` shape (${noFinish.join(", ")}) carries no finish reason, so "Cut off mid-answer" is always 0 for it. Check its names for a last name that stops short.`,
		);

	const failures = input.models.flatMap(({ key, results }) => {
		const first = results.find((r) => r.error);

		return first ? [`- ${label(key)}: ${first.error}`] : [];
	});

	if (failures.length > 0)
		lines.push("", "First error per model:", ...failures);

	const texts = [
		...new Set(input.models.flatMap((m) => m.results.map((r) => r.text))),
	];

	lines.push(
		"",
		"## Side by side",
		"",
		`| Bank text | ${input.models.map((m) => label(m.key)).join(" | ")} |`,
		`|---|${input.models.map(() => "---").join("|")}|`,
	);

	for (const text of texts) {
		const row = input.models.map((m) =>
			show(m.results.find((r) => r.text === text)),
		);

		lines.push(`| ${cell(text)} | ${row.join(" | ")} |`);
	}

	return `${lines.join("\n")}\n`;
}

/** A missing parameter is no limit; a present one must be a whole number above zero, or the request is refused. */
const numberOf = (name: string, value: string | null): number | undefined => {
	if (value === null) return undefined;
	const parsed = Number(value);

	if (!Number.isInteger(parsed) || parsed < 1)
		throw new Error(
			`${name} must be a whole number above zero, got "${value}".`,
		);

	return parsed;
};

export default {
	async fetch(request: Request, env: CompareEnv): Promise<Response> {
		const url = new URL(request.url);

		// Every run is billed, so only GET / starts one: not a favicon fetch, a health probe or a HEAD.
		if (url.pathname !== "/") return new Response("Not found", { status: 404 });

		if (request.method !== "GET")
			return new Response("GET only", { status: 405 });
		// A browser marks a request made for another page (an image tag, a link) with Sec-Fetch-Site or Origin.
		// Refuse those, so a page you visit can't start a billed run. curl, and typing the address, send neither.
		const site = request.headers.get("sec-fetch-site");

		if ((site !== null && site !== "none") || request.headers.has("origin"))
			return new Response(
				"Run this with curl, or by typing the address, not from another page.",
				{ status: 403 },
			);
		const models = url.searchParams.get("models");

		try {
			const report = await runNamesComparison(env, {
				// Only a missing parameter means every model; an empty one is refused as an unknown model.
				models:
					models === null ? undefined : models.split(",").map((m) => m.trim()),
				limit: numberOf("limit", url.searchParams.get("limit")),
				tokens: numberOf("tokens", url.searchParams.get("tokens")),
				// A missing task is the name prompt; an unknown one is refused before any call.
				task: url.searchParams.get("task") ?? undefined,
			});

			return new Response(report, {
				headers: { "content-type": "text/markdown; charset=utf-8" },
			});
		} catch (error) {
			return new Response(error instanceof Error ? error.message : "failed", {
				status: 400,
			});
		}
	},
};
