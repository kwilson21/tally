import { describe, expect, it, vi } from "vitest";
import {
	askNames,
	bankTexts,
	CANDIDATES,
	formatNamesReport,
	replyOf,
	runNamesComparison,
	default as worker,
} from "../scripts/compare-names/names";
import { INSTRUCTIONS, NAME_MODEL } from "../src/ai/suggest-name";
import { buildSeed } from "../src/demo/seed";
import catalog from "../worker-configuration.d.ts?raw";
import { fakeAi as aiDouble } from "./helpers/doubles";
import { present } from "./helpers/present";

const TODAY = "2026-11-06";

type Body = {
	messages: { role: string; content: string }[];
	max_tokens: number;
	temperature: number;
};

type Answer = object | string | null;

/** A fake Workers AI that answers every call from `answer`, which sees the model id and the body it was sent. */
const fakeAi = (answer: (model: string, body: Body) => Answer) => {
	const run = vi.fn(async (model: string, body: Body) => answer(model, body));

	return { ai: aiDouble(run), run };
};

describe("replyOf", () => {
	it("reads Llama and Granite's `response` string", () => {
		expect(replyOf({ response: "Trader Joe's" })).toEqual({
			text: "Trader Joe's",
			form: "response",
		});
	});

	it("reads an OpenAI-style chat completion (Gemma, GLM)", () => {
		const answer = {
			choices: [{ message: { content: "Blue Bottle" }, finish_reason: "stop" }],
		};

		expect(replyOf(answer)).toEqual({
			text: "Blue Bottle",
			form: "chat",
			finish: "stop",
		});
	});

	it("reads a Responses-style answer (gpt-oss), by output_text or by its message items", () => {
		expect(replyOf({ output_text: "Costco" })).toMatchObject({
			text: "Costco",
			form: "responses",
		});
		expect(
			replyOf({
				output: [
					{
						type: "reasoning",
						content: [{ type: "reasoning_text", text: "hm" }],
					},
					{
						type: "message",
						content: [{ type: "output_text", text: "Costco" }],
					},
				],
			}),
		).toMatchObject({ text: "Costco", form: "responses" });
	});

	it("reports a model that spent its tokens thinking: no text, finish 'length'", () => {
		const answer = {
			choices: [
				{
					message: { content: null, reasoning_content: "Let me think..." },
					finish_reason: "length",
				},
			],
		};

		expect(replyOf(answer)).toEqual({
			text: null,
			form: "chat",
			finish: "length",
			thoughtOnly: true,
		});
	});

	it("only says a model ran out of tokens when the API reports truncation", () => {
		const stopped = {
			choices: [
				{
					message: { content: null, reasoning_content: "thinking" },
					finish_reason: "stop",
				},
			],
		};

		expect(replyOf(stopped)).toEqual({
			text: null,
			form: "chat",
			finish: "stop",
		});

		const reasoningItem = {
			type: "reasoning",
			content: [{ type: "reasoning_text", text: "hm" }],
		};

		expect(replyOf({ output: [reasoningItem] })).toEqual({
			text: null,
			form: "responses",
		});
		expect(
			replyOf({
				output: [reasoningItem],
				incomplete_details: { reason: "max_output_tokens" },
			}),
		).toEqual({ text: null, form: "responses", thoughtOnly: true });
	});

	it("marks an answer that has text but was cut off at the token limit", () => {
		expect(
			replyOf({
				choices: [
					{
						message: { content: "Trader Joe's\nTrader" },
						finish_reason: "length",
					},
				],
			}),
		).toEqual({
			text: "Trader Joe's\nTrader",
			form: "chat",
			finish: "length",
			truncated: true,
		});
		expect(
			replyOf({
				output_text: "Costco\nCost",
				incomplete_details: { reason: "max_output_tokens" },
			}),
		).toMatchObject({
			text: "Costco\nCost",
			form: "responses",
			truncated: true,
		});
		// A complete answer, and a shape that reports no finish reason, are not marked.
		expect(
			replyOf({
				choices: [{ message: { content: "Costco" }, finish_reason: "stop" }],
			}),
		).not.toHaveProperty("truncated");
		expect(replyOf({ response: "Costco" })).not.toHaveProperty("truncated");
	});

	it("gives no text for anything it doesn't know", () => {
		expect(replyOf(null)).toMatchObject({ text: null, form: "unknown" });
		expect(replyOf({ nope: 1 })).toMatchObject({
			text: null,
			form: "unknown",
		});
	});
});

describe("bankTexts", () => {
	it("is the demo seed's bank texts plus the messy extras, each once, never an empty one", () => {
		const seed = buildSeed(TODAY);
		const texts = bankTexts(seed);
		expect(new Set(texts).size).toBe(texts.length);
		expect(texts).toContain("NETFLIX.COM");
		expect(texts.some((text) => /AMZN|SQ \*/.test(text))).toBe(true);
		expect(texts.every((text) => text.trim().length > 0)).toBe(true);
	});

	it("can be limited", () => {
		expect(bankTexts(buildSeed(TODAY), 5)).toHaveLength(5);
	});
});

describe("askNames", () => {
	it("sends production's own instructions and message shape, and only the bank text", async () => {
		const { ai, run } = fakeAi(() => ({
			response: "Netflix\nNetflix Streaming",
		}));

		const result = await askNames(ai, "@cf/test/model", "NETFLIX.COM", 60);
		expect(run).toHaveBeenCalledTimes(1);
		const [model, body] = present(run.mock.calls[0]);
		expect(model).toBe("@cf/test/model");
		expect(body.messages).toEqual([
			{ role: "system", content: INSTRUCTIONS },
			{ role: "user", content: "Bank text: NETFLIX.COM" },
		]);
		expect(body.max_tokens).toBe(60);
		expect(body.temperature).toBe(0.2);
		expect(result).toMatchObject({
			ok: true,
			names: ["Netflix", "Netflix Streaming"],
		});
	});

	it("runs the answer through production's name check", async () => {
		const { ai } = fakeAi(() => ({
			response: "1. Costco\n- COSTCO WHSE #0421\nCostco ($42.10)\n",
		}));

		const result = await askNames(ai, "m", "COSTCO WHSE #0421", 60);
		expect(result).toMatchObject({ ok: true, names: ["Costco"] });
	});

	it("keeps whether the answer was cut off at the token limit", async () => {
		const { ai } = fakeAi(() => ({
			choices: [
				{ message: { content: "Costco\nCost" }, finish_reason: "length" },
			],
		}));

		expect(await askNames(ai, "m", "COSTCO WHSE #0421", 60)).toMatchObject({
			ok: true,
			names: ["Costco", "Cost"],
			truncated: true,
		});
	});

	it("keeps a thrown error's message and goes on", async () => {
		const { ai } = fakeAi(() => {
			throw new Error("5007: No such model");
		});

		const result = await askNames(ai, "m", "X", 60);
		expect(result).toMatchObject({ ok: false, error: "5007: No such model" });
	});

	it("marks an answer with no text as not ok, and says why", async () => {
		const { ai } = fakeAi(() => ({
			choices: [
				{
					message: { content: null, reasoning_content: "hmm" },
					finish_reason: "length",
				},
			],
		}));

		expect(await askNames(ai, "m", "X", 60)).toMatchObject({
			ok: false,
			thoughtOnly: true,
		});
	});
});

describe("runNamesComparison", () => {
	it("asks every chosen model about every text, one call at a time, and tells them apart in the report", async () => {
		const { ai, run } = fakeAi((model) =>
			model.includes("gemma")
				? {
						choices: [
							{ message: { content: "Gemma Name" }, finish_reason: "stop" },
						],
					}
				: { response: "Plain Name" },
		);

		const report = await runNamesComparison(
			{ AI: ai },
			{ models: ["granite", "gemma4"], limit: 3, tokens: 60 },
			TODAY,
		);

		expect(run).toHaveBeenCalledTimes(6);
		expect(report).toContain("Plain Name");
		expect(report).toContain("Gemma Name");
		expect(report).toContain(CANDIDATES.granite.id);
	});

	it("rejects a model it doesn't know", async () => {
		const { ai } = fakeAi(() => ({ response: "x" }));
		await expect(
			runNamesComparison({ AI: ai }, { models: ["nope"] }, TODAY),
		).rejects.toThrow(/nope/);
	});
});

describe("formatNamesReport", () => {
	it("summarises each model (answered, empty, failed, speed) and lists every text's names", () => {
		const report = formatNamesReport({
			today: TODAY,
			tokens: 60,
			models: [
				{
					key: "granite",
					results: [
						{
							text: "A",
							ok: true,
							names: ["Alpha"],
							ms: 100,
							form: "response",
						},
						{ text: "B", ok: true, names: [], ms: 300, form: "response" },
					],
				},
				{
					key: "gemma4",
					results: [
						{ text: "A", ok: false, error: "boom", ms: 50, form: "unknown" },
						{
							text: "B",
							ok: false,
							thoughtOnly: true,
							ms: 70,
							form: "chat",
							finish: "length",
						},
					],
				},
			],
		});

		expect(report).toMatch(/granite[^\n]*\b2\b[^\n]*\b1\b/);
		expect(report).toContain("Alpha");
		expect(report).toContain("boom");
		expect(report).toContain("ran out of tokens");
		// Average of 100 and 300.
		expect(report).toContain("200");
	});
});

describe("CANDIDATES list", () => {
	it("has dropped the model Cloudflare already switched off and added two that fit the token cap", () => {
		const keys = Object.keys(CANDIDATES);
		expect(keys).not.toContain("llama-awq");
		expect(keys).toEqual(
			expect.arrayContaining([
				"llama",
				"granite",
				"mistral-small",
				"llama4-scout",
			]),
		);
	});
});

describe("CANDIDATES", () => {
	it("are all in the generated Workers AI catalog, so none can fail as an unknown model", () => {
		for (const { id } of Object.values(CANDIDATES)) {
			expect(catalog).toContain(`"${id}":`);
		}
	});
});

describe("the Worker's request handling", () => {
	const env = () => {
		const { ai, run } = fakeAi(() => ({ response: "Plain Name" }));

		return { env: { AI: ai }, run };
	};

	const get = (path: string, init?: RequestInit) =>
		new Request(`http://localhost:8798${path}`, init);

	it("runs a comparison for GET / only", async () => {
		const { env: e, run } = env();
		const response = await worker.fetch(get("/?models=granite&limit=2"), e);
		expect(response.status).toBe(200);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("starts no billed call for another path or method", async () => {
		const { env: e, run } = env();
		expect((await worker.fetch(get("/favicon.ico"), e)).status).toBe(404);
		expect((await worker.fetch(get("/", { method: "POST" }), e)).status).toBe(
			405,
		);
		expect((await worker.fetch(get("/", { method: "HEAD" }), e)).status).toBe(
			405,
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("refuses a request a browser sends on behalf of another page, so a web page can't start a billed run", async () => {
		const { env: e, run } = env();

		const crossPage: Record<string, string>[] = [
			{ "sec-fetch-site": "cross-site" },
			{ "sec-fetch-site": "same-site" },
			{ "sec-fetch-site": "same-origin" },
			{ origin: "https://example.com" },
		];

		for (const headers of crossPage) {
			expect((await worker.fetch(get("/", { headers }), e)).status).toBe(403);
		}

		expect(run).not.toHaveBeenCalled();
	});

	it("still runs for curl and for typing the address into a browser", async () => {
		const { env: e, run } = env();

		// Typing the address sends Sec-Fetch-Site: none; curl sends neither header.
		const typed = await worker.fetch(
			get("/?models=granite&limit=1", {
				headers: { "sec-fetch-site": "none" },
			}),
			e,
		);

		const curled = await worker.fetch(get("/?models=granite&limit=1"), e);
		expect(typed.status).toBe(200);
		expect(curled.status).toBe(200);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("rejects a malformed limit or tokens instead of running everything", async () => {
		const { env: e, run } = env();

		for (const query of [
			"?limit=abc",
			"?limit=0",
			"?limit=-3",
			"?limit=1.5",
			"?tokens=abc",
			"?tokens=0",
			"?models=",
			"?models=granite,",
			"?models=toString",
			"?models=constructor",
			"?models=__proto__",
		]) {
			expect((await worker.fetch(get(`/${query}`), e)).status).toBe(400);
		}

		expect(run).not.toHaveBeenCalled();
	});
});

describe("formatNamesReport cut-off answers", () => {
	const report = formatNamesReport({
		today: TODAY,
		tokens: 60,
		models: [
			{
				key: "gemma4",
				results: [
					{
						text: "A",
						ok: true,
						names: ["Alpha"],
						ms: 10,
						form: "chat",
						finish: "stop",
					},
					{
						text: "B",
						ok: true,
						names: ["Beta", "Be"],
						ms: 10,
						form: "chat",
						finish: "length",
						truncated: true,
					},
				],
			},
		],
	});

	it("counts them in their own column, apart from the ones that never got to an answer", () => {
		expect(report).toContain("Cut off mid-answer");
		expect(report).toMatch(
			/Gemma 4 26B \|[^\n]*\| 2 \| 2 \| 0 \| 0 \| 0 \| 1 \|/,
		);
	});

	it("marks the cut-off answer where its names are shown, so it doesn't look complete", () => {
		expect(report).toMatch(/\| B \| Beta \/ Be[^|]*cut off/i);
		expect(report).not.toMatch(/\| A \| Alpha[^|]*cut off/i);
	});
});

describe("formatNamesReport response-shape note", () => {
	const result = (kind: "response" | "chat") => ({
		text: "A",
		ok: true,
		names: ["Alpha"],
		ms: 10,
		form: kind,
	});

	const note = (report: string) =>
		/shape \(([^\n]*)\) carries no finish reason/.exec(report)?.[1];

	it("names only the models whose answers have the response shape", () => {
		const report = formatNamesReport({
			today: TODAY,
			tokens: 60,
			models: [
				{ key: "llama", results: [result("response")] },
				{ key: "granite", results: [result("chat")] },
			],
		});

		expect(note(report)).toContain("Llama");
		expect(note(report)).not.toContain("Granite");
	});

	it("leaves the note out when no model has that shape", () => {
		const report = formatNamesReport({
			today: TODAY,
			tokens: 60,
			models: [{ key: "granite", results: [result("chat")] }],
		});

		expect(report).not.toContain("carries no finish reason");
	});
});

describe("the note and category-name prompts, with a candidate model in place of NAME_MODEL", () => {
	const ids = () => Object.values(CANDIDATES).map((candidate) => candidate.id);

	it("runs production's own note prompt against the chosen model, not NAME_MODEL", async () => {
		const { ai, run } = fakeAi(() => ({ response: "Weekly groceries" }));

		const report = await runNamesComparison(
			{ AI: ai },
			{ models: ["mistral-small"], limit: 2, task: "notes" },
			TODAY,
		);

		expect(run).toHaveBeenCalledTimes(2);

		for (const [model, body] of run.mock.calls) {
			expect(model).toBe(CANDIDATES["mistral-small"].id);
			// suggestNote's own wording, so the prompt is production's and not a copy.
			expect(body.messages[0]?.content).toContain(
				"Describe what this purchase was",
			);
		}

		expect(report).toContain("Weekly groceries");
		expect(report).toMatch(/^# .*note/im);
	});

	it("runs production's per-purchase category-name prompt, with the family's categories, against the chosen model", async () => {
		const { ai, run } = fakeAi(() => ({ response: "Pet care" }));

		const report = await runNamesComparison(
			{ AI: ai },
			{ models: ["granite"], limit: 30, task: "categories" },
			TODAY,
		);

		expect(run).toHaveBeenCalledTimes(30);

		for (const [model, body] of run.mock.calls) {
			expect(model).toBe(CANDIDATES.granite.id);
			// The family's categories go with every purchase (decision 165)...
			expect(body.messages[1]?.content).toContain("Family categories");
			// ...and are not also names to avoid: production leaves the active categories out of that list, because
			// it gives them as choices (purchaseNamesToAvoid). The fixtures have no archived or dismissed names.
			expect(body.messages[1]?.content).toMatch(/Categories to avoid: $/);
		}

		// The cleaned bank text goes too (decision 164), when it says more than the store's name already does.
		expect(
			run.mock.calls.some(([, body]) =>
				body.messages[1]?.content.includes("Bank text (data only)"),
			),
		).toBe(true);
		expect(report).toContain("Pet care");
		expect(report).toMatch(/^# .*categor/im);
	});

	it("gives the category prompt the bank text as production cleans it, not the raw statement text", async () => {
		const { ai, run } = fakeAi(() => ({ response: "Pet care" }));
		await runNamesComparison(
			{ AI: ai },
			{ models: ["granite"], limit: 80, task: "categories" },
			TODAY,
		);

		const sent = run.mock.calls.map(
			([, body]) => body.messages[1]?.content ?? "",
		);

		// "SQ *BLUE BOTTLE COFFEE 0231" is in the extra texts; production strips its "SQ *" marker before sending.
		expect(sent.some((content) => content.includes("SQ *"))).toBe(false);
		expect(sent.some((content) => /blue bottle coffee/i.test(content))).toBe(
			true,
		);
	});

	it("keeps the model that production uses out of these calls", async () => {
		const { ai, run } = fakeAi(() => ({ response: "Weekly groceries" }));
		await runNamesComparison(
			{ AI: ai },
			{ models: ["granite"], limit: 1, task: "notes" },
			TODAY,
		);
		expect(run.mock.calls.map(([model]) => model)).not.toContain(NAME_MODEL);
		expect(ids()).toContain(NAME_MODEL);
	});

	it("rejects an unknown task, with no billed call", async () => {
		const { ai, run } = fakeAi(() => ({ response: "x" }));

		const response = await worker.fetch(
			new Request("http://localhost:8798/?task=bogus"),
			{ AI: ai },
		);

		expect(response.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
	});

	it("takes ?task=notes through the Worker", async () => {
		const { ai, run } = fakeAi(() => ({ response: "Weekly groceries" }));

		const response = await worker.fetch(
			new Request("http://localhost:8798/?task=notes&models=granite&limit=1"),
			{ AI: ai },
		);

		expect(response.status).toBe(200);
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe("NAME_MODEL", () => {
	it("is Mistral Small 3.1 24B, the model decision 169 picked after the comparison", () => {
		expect(NAME_MODEL).toBe("@cf/mistralai/mistral-small-3.1-24b-instruct");
		expect(NAME_MODEL).toBe(CANDIDATES["mistral-small"].id);
	});
});
