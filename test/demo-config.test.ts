import { describe, expect, it } from "vitest";
import config from "../cloudflare.config";
import { present } from "./helpers/present";

// cloudflare.config.ts returns one whole configuration for each mode (decision 205). These read what it returns for
// the demo, for production and for no mode (local development and the tests).
const demo = config({ mode: "demo", isPreview: false }).worker;
const production = config({ mode: "production", isPreview: false }).worker;
const local = config({ mode: undefined, isPreview: false }).worker;

const crons = (triggers: readonly { type: string; schedule?: string }[]) =>
	triggers.flatMap((trigger) =>
		trigger.type === "scheduled" ? [trigger.schedule] : [],
	);

describe("demo environment config", () => {
	it("runs as the demo", () => {
		expect(demo.env.DEMO).toEqual({ type: "text", value: "true" });
	});

	it("never mentions Plaid, so it can't hold Plaid settings", () => {
		expect(JSON.stringify(demo)).not.toMatch(/plaid/i);
	});

	it("binds only the demo database", () => {
		const databases = Object.values(demo.env).filter(
			(binding) => binding?.type === "d1",
		);

		expect(databases).toHaveLength(1);
		expect(demo.env.DB).toEqual({
			type: "d1",
			name: "tally-demo",
			id: "ce0d954f-0f85-46bf-9a25-0890c589e383",
		});
	});

	it("is served only at its custom domain", () => {
		expect(demo.domains).toEqual(["tally-demo.thesuperhuman.us"]);
		expect(crons(present(demo.triggers))).toHaveLength(
			present(demo.triggers).length,
		);
		expect(demo.workersDev).toBe(false);
		expect(demo.previewUrls).toBe(false);
	});

	it("resets, sorts and names in one run nightly at 09:00 UTC", () => {
		expect(crons(present(demo.triggers))).toEqual(["0 9 * * *"]);
	});

	it("keeps crons out of local dev and other environments", () => {
		expect("triggers" in local).toBe(false);
	});
});

describe("production environment config (#23)", () => {
	it("is not the demo, so the nightly reset can never run here", () => {
		expect(production.env.DEMO).toEqual({ type: "text", value: "false" });
	});

	it("binds its own database, never the demo's", () => {
		const databases = Object.values(production.env).filter(
			(binding) => binding?.type === "d1",
		);

		expect(databases).toHaveLength(1);
		expect(production.env.DB).toEqual({
			type: "d1",
			name: "tally-production",
			id: "97a4d15e-58a4-4067-b74e-6101195c6493",
		});
		expect(production.env.DB.id).not.toBe(demo.env.DB.id);
	});

	it("is served only at tally.thesuperhuman.us, never finance.*", () => {
		expect(production.domains).toEqual(["tally.thesuperhuman.us"]);
		expect(crons(present(production.triggers))).toHaveLength(
			present(production.triggers).length,
		);
		expect(production.workersDev).toBe(false);
		expect(production.previewUrls).toBe(false);
		expect(JSON.stringify(production)).not.toContain("finance.");
	});

	// Decision 139: the night is one Workflow that the 09:00 run starts; reconnect reminders have a dedicated invocation.
	it("runs the sync and the night's Workflow at 09:00 UTC, then reconnect reminders at 10:00, with no sort runs between them (decision 139)", () => {
		// Plus the minute's ready email alone, which starts no sort (decision 146).
		expect(crons(present(production.triggers))).toEqual([
			"0 9 * * *",
			"0 10 * * *",
			"* * * * *",
		]);
	});

	it("binds Workers AI for merchant names (#33) in production and the demo, not in local development", () => {
		expect(production.env.AI).toEqual({ type: "ai" });
		expect(demo.env.AI).toEqual({ type: "ai" });
		expect("AI" in local.env).toBe(false);
	});

	it("holds no secrets or Plaid settings; those go in with wrangler secret put", () => {
		expect(JSON.stringify(production)).not.toMatch(
			/plaid|secret|token|jev|access_aud|team_domain/i,
		);
	});
});

describe("each mode is its own Worker", () => {
	it("names a different Worker, database and Workflow in each mode, so one can never deploy over another", () => {
		const modes = [local, demo, production];

		expect(new Set(modes.map((worker) => worker.name)).size).toBe(3);
		expect(new Set(modes.map((worker) => worker.env.DB.id)).size).toBe(3);
		expect(new Set(modes.map((worker) => worker.env.SORT.name)).size).toBe(3);
	});

	it("points each Workflow binding at its own Worker", () => {
		for (const worker of [local, demo, production])
			expect(worker.env.SORT.worker).toBe(worker.name);
	});
});
