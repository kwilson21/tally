// Measures Clef and Clef-flash against Jev on the demo seed (decision 136, #729). It asks each model Tally's own
// call (askJev) about every demo case, once with the demo's 7 categories and once with 50, scores each answer
// with decide at JEV_THRESHOLD, and returns a markdown report. Never deploy it: it bills Workers AI and Jev.
// Only JEV_API_KEY is read from the env file. It needs `npx wrangler login`. Run it locally:
//   npx wrangler dev --config scripts/compare-models/wrangler.jsonc --env-file "$(pwd)/.dev.vars" --port 8799
//   curl -s http://localhost:8799/
// The env file path must be absolute, since Wrangler resolves it from the config's folder. Add ?model=clef&list=demo
// (model: jev, clef or clef-flash; list: demo or fifty) to run one slice.
import { askJev, type JevInput, type JevResult } from "../../src/ai/categorize";
import { DEFAULT_TIME_ZONE, todayIn } from "../../src/dates";
import { buildSeed } from "../../src/demo/seed";
import { formatReport, type ModelNote, type ReportList } from "./report";
import {
	buildCases,
	type Case,
	demoCategories,
	fiftyCategories,
	type Row,
	scoreCase,
	skippedRow,
} from "./score";

export type CompareEnv = { AI: Ai; JEV_API_KEY?: string };
export type ModelId = "jev" | "clef" | "clef-flash";
export type ListId = "demo" | "fifty";
export type Slice = { models?: ModelId[]; lists?: ListId[] };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MODELS: ModelId[] = ["jev", "clef", "clef-flash"];
const LISTS: ListId[] = ["demo", "fifty"];
const MODEL_NAMES: Record<ModelId, string> = {
	jev: "Jev",
	clef: "Clef",
	"clef-flash": "Clef-flash",
};
/** Each Workers AI model's id; its selector in the body is the same as its key here. */
const WORKERS_AI: Record<Exclude<ModelId, "jev">, string> = {
	clef: "@cf/cloudflare/clef",
	"clef-flash": "@cf/cloudflare/clef-flash",
};
/** The household's one person, as every household starts with (migrations/0030). */
const OPTIONS = { details: true, people: [{ id: 1, name: "Everyone" }] };

/**
 * Workers AI as the fetch askJev expects: the same body with `model` set to the selector. A throw is left to
 * askJev, which reports it as no response, as it does for a Jev timeout. Workers AI takes no key, so the
 * Authorization header askJev sets is ignored.
 */
export function viaWorkersAI(
	ai: Ai,
	modelId: string,
	selector: string,
): FetchLike {
	return async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const answer = await ai.run(
			modelId,
			{ ...body, model: selector },
			{ signal: init?.signal ?? undefined },
		);
		return Response.json(answer);
	};
}

type Recorder = {
	error?: string;
	/** The last response body, kept so an unreadable one can be saved. */
	body?: string;
	unreadable?: string;
	usage?: unknown;
};

const usageOf = (text: string): unknown => {
	try {
		return (JSON.parse(text) as { usage?: unknown }).usage;
	} catch {
		return undefined;
	}
};

/** Wraps a model's fetch to keep, for the report, its first thrown error and its first usage. */
function recording(fetchImpl: FetchLike, rec: Recorder): FetchLike {
	return async (url, init) => {
		let response: Response;
		try {
			response = await fetchImpl(url, init);
		} catch (error) {
			rec.error ??= error instanceof Error ? error.message : String(error);
			throw error;
		}
		const text = await response.clone().text();
		rec.body = text;
		rec.usage ??= usageOf(text);
		return response;
	};
}

type Asker = (input: JevInput, categories: string[]) => Promise<JevResult>;

type ModelRun = { model: ModelId; rec: Recorder; asker: Asker | null };

/** One model's run: its asker, or none when Jev has no key (Jev is then skipped, and Clef still runs). */
function modelRun(
	model: ModelId,
	env: CompareEnv,
	fetchImpl: FetchLike,
): ModelRun {
	const rec: Recorder = {};
	if (model === "jev") {
		const key = env.JEV_API_KEY;
		const asker: Asker | null = key
			? (input, categories) =>
					askJev(input, categories, key, recording(fetchImpl, rec), OPTIONS)
			: null;
		return { model, rec, asker };
	}
	const workersAi = viaWorkersAI(env.AI, WORKERS_AI[model], model);
	return {
		model,
		rec,
		asker: (input, categories) =>
			askJev(input, categories, "", recording(workersAi, rec), OPTIONS),
	};
}

/** Runs one model over every case for one list: one call at a time, no retries. */
async function rowsFor(
	run: ModelRun,
	list: ReportList,
	cases: Case[],
): Promise<Row[]> {
	if (!run.asker) return cases.map(() => skippedRow());
	const rows: Row[] = [];
	for (const [index, kase] of cases.entries()) {
		const started = Date.now();
		const result = await run.asker(kase.input, list.categories);
		const row = scoreCase(kase, result, list.categories, Date.now() - started);
		if (row.outcome === "unreadable") run.rec.unreadable ??= run.rec.body;
		console.log(
			`compare-models ${run.model} ${list.id} case ${index + 1} ${row.outcome} ${row.ms}ms`,
		);
		rows.push(row);
	}
	return rows;
}

/**
 * The report for the asked-for slice of the demo seed on `today`. `fetchImpl` is Jev's fetch; Clef and
 * Clef-flash go through env.AI.
 */
export async function runComparison(
	env: CompareEnv,
	fetchImpl: FetchLike = fetch,
	today: string = todayIn(DEFAULT_TIME_ZONE),
	slice: Slice = {},
): Promise<string> {
	const seed = buildSeed(today);
	const cases = buildCases(seed);
	const runs = (slice.models ?? MODELS).map((model) =>
		modelRun(model, env, fetchImpl),
	);
	const lists: ReportList[] = [];
	for (const id of slice.lists ?? LISTS) {
		const categories =
			id === "demo" ? demoCategories(seed) : fiftyCategories(seed);
		const list: ReportList = {
			id,
			title:
				id === "demo"
					? `The demo's ${categories.length} categories`
					: `The ${categories.length} categories`,
			categories,
			models: [],
		};
		for (const run of runs) {
			list.models.push({
				name: MODEL_NAMES[run.model],
				rows: await rowsFor(run, list, cases),
			});
		}
		lists.push(list);
	}
	const notes: ModelNote[] = runs.map(({ model, rec }) => ({
		name: MODEL_NAMES[model],
		error: rec.error,
		unreadable: rec.unreadable,
		usage: rec.usage,
	}));
	const jev = runs.find((run) => run.model === "jev");
	const jevStatus = !jev
		? "not in this run"
		: jev.asker
			? "ran"
			: "skipped, no JEV_API_KEY";
	return formatReport({ today, cases, jevStatus, lists, notes });
}

const isOneOf = <T extends string>(
	values: readonly T[],
	value: string,
): value is T => (values as readonly string[]).includes(value);

export default {
	async fetch(request: Request, env: CompareEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/") return new Response("Not found", { status: 404 });
		if (request.method !== "GET")
			return new Response("Method not allowed", { status: 405 });
		const modelParam = url.searchParams.get("model");
		const listParam = url.searchParams.get("list");
		const models =
			modelParam === null
				? MODELS
				: isOneOf(MODELS, modelParam)
					? [modelParam]
					: null;
		const lists =
			listParam === null
				? LISTS
				: isOneOf(LISTS, listParam)
					? [listParam]
					: null;
		// A typo gets a 400, not a full paid run.
		if (!models || !lists) {
			return new Response(
				"Unknown model or list. Use model=jev, clef or clef-flash, and list=demo or fifty.",
				{ status: 400 },
			);
		}
		const text = await runComparison(env, fetch, todayIn(DEFAULT_TIME_ZONE), {
			models,
			lists,
		});
		return new Response(text, {
			headers: { "content-type": "text/markdown; charset=utf-8" },
		});
	},
};
