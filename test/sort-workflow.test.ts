import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";

// The real SortWorkflow class, run by the Workflows binding from wrangler.jsonc (the step behaviour is in
// sort-groups.test.ts). The instance gets a Jev key and a stubbed Jev, so its saved steps really run: the ask
// step's answer returns to run() and the write saves it.

const db = env.DB;
const TODAY = "2026-09-22";

/** A Jev reply: Eating Out at 0.9, no flags. */
const jevReply = () =>
	new Response(
		JSON.stringify({
			answers: {
				category: { type: "choice", choice: "Eating Out", confidence: 0.9 },
				transfer: { type: "noul", noul: 0.01 },
				reimbursement: { type: "noul", noul: 0.01 },
				income: { type: "noul", noul: 0.01 },
			},
		}),
		{ status: 200 },
	);

beforeEach(async () => {
	await resetDemo(db, TODAY);
	await saveAiSwitches(db, { details: false });
	await db
		.prepare(
			"DELETE FROM household_settings WHERE key = 'sorting_turn' OR key GLOB 'jev_calls_*'",
		)
		.run();
});

afterEach(() => {
	delete (env as { JEV_API_KEY?: string }).JEV_API_KEY;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("SortWorkflow", () => {
	it("runs its saved steps to completion, sorts the row it was given, and logs no stop", async () => {
		const row = await db
			.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,-500,'WORKFLOW SMOKE') RETURNING id",
			)
			.bind(TODAY)
			.first<{ id: number }>();
		const id = Number(row?.id);
		(env as { JEV_API_KEY?: string }).JEV_API_KEY = "test-key";
		const fetchJev = vi.fn(async () => jevReply());
		vi.stubGlobal("fetch", fetchJev);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const introspector = await introspectWorkflow(env.SORT);
		try {
			await introspector.modifyAll(async (m) => {
				await m.disableRetryDelays();
			});
			const instance = await env.SORT.create({
				params: { ids: [id], bySync: false, rulesApplied: false },
			});
			let status = await instance.status();
			for (
				let i = 0;
				i < 100 && status.status !== "complete" && status.status !== "errored";
				i++
			) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await instance.status();
			}
			expect({ status: status.status, error: status.error?.name }).toEqual({
				status: "complete",
				error: undefined,
			});
		} finally {
			await introspector.dispose();
		}
		expect(fetchJev).toHaveBeenCalledTimes(1);
		const sorted = await db
			.prepare(
				"SELECT category_source AS source FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{ source: string | null }>();
		expect(sorted?.source).toBe("jev");
		expect(errors).not.toHaveBeenCalledWith(
			expect.stringMatching(/^sorting: stopped/),
		);
	});

	it("runs the night's instance to completion with no Jev key, and logs no stop or failure", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const introspector = await introspectWorkflow(env.SORT);
		try {
			await introspector.modifyAll(async (m) => {
				await m.disableRetryDelays();
			});
			const instance = await env.SORT.create({
				params: { bySync: false, rulesApplied: false, night: TODAY },
			});
			let status = await instance.status();
			for (
				let i = 0;
				i < 100 && status.status !== "complete" && status.status !== "errored";
				i++
			) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await instance.status();
			}
			expect({ status: status.status, error: status.error?.name }).toEqual({
				status: "complete",
				error: undefined,
			});
		} finally {
			await introspector.dispose();
		}
		expect(errors).not.toHaveBeenCalledWith(
			expect.stringMatching(/stopped|failed/),
		);
	});

	it("waits out a busy Jev through a real step.sleep: a 429, then the answer, with two Jev calls", async () => {
		const row = await db
			.prepare(
				"INSERT INTO transactions(account_id,date,amount_cents,raw_name) VALUES(1,?,-500,'WORKFLOW BUSY') RETURNING id",
			)
			.bind(TODAY)
			.first<{ id: number }>();
		const id = Number(row?.id);
		(env as { JEV_API_KEY?: string }).JEV_API_KEY = "test-key";
		let call = 0;
		const fetchJev = vi.fn(async () => {
			call += 1;
			return call === 1
				? new Response("{}", { status: 429, headers: { "retry-after": "5" } })
				: jevReply();
		});
		vi.stubGlobal("fetch", fetchJev);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const introspector = await introspectWorkflow(env.SORT);
		try {
			await introspector.modifyAll(async (m) => {
				await m.disableRetryDelays();
				await m.disableSleeps();
			});
			const instance = await env.SORT.create({
				params: { ids: [id], bySync: false, rulesApplied: false },
			});
			let status = await instance.status();
			for (
				let i = 0;
				i < 100 && status.status !== "complete" && status.status !== "errored";
				i++
			) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				status = await instance.status();
			}
			expect({ status: status.status, error: status.error?.name }).toEqual({
				status: "complete",
				error: undefined,
			});
		} finally {
			await introspector.dispose();
		}
		expect(fetchJev).toHaveBeenCalledTimes(2);
		const sorted = await db
			.prepare(
				"SELECT category_source AS source FROM transactions WHERE id = ?",
			)
			.bind(id)
			.first<{ source: string | null }>();
		expect(sorted?.source).toBe("jev");
		expect(errors).not.toHaveBeenCalledWith(
			expect.stringMatching(/^sorting: stopped/),
		);
	});
});
