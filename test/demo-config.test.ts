import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

/** Removes line and block comments outside strings, turning JSONC into JSON. */
function stripJsoncComments(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			out += c;
			if (c === "\\") out += text[++i];
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
			out += c;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 1;
		} else {
			out += c;
		}
	}
	return out;
}

const config = JSON.parse(stripJsoncComments(raw));
const demo = config.env.demo;
const production = config.env.production;

describe("demo environment config", () => {
	it("runs as the demo", () => {
		expect(demo.vars).toEqual({ DEMO: "true" });
	});

	it("never mentions Plaid, so it can't hold Plaid settings", () => {
		expect(JSON.stringify(demo)).not.toMatch(/plaid/i);
	});

	it("binds only the demo database", () => {
		expect(demo.d1_databases).toHaveLength(1);
		expect(demo.d1_databases[0]).toMatchObject({
			binding: "DB",
			database_name: "tally-demo",
			database_id: "ce0d954f-0f85-46bf-9a25-0890c589e383",
		});
	});

	it("is served only at its custom domain", () => {
		expect(demo.routes).toEqual([
			{ pattern: "tally-demo.thesuperhuman.us", custom_domain: true },
		]);
		expect(demo.workers_dev).toBe(false);
		expect(demo.preview_urls).toBe(false);
	});

	it("resets nightly at 09:00 UTC", () => {
		expect(demo.triggers).toEqual({ crons: ["0 9 * * *"] });
	});

	it("keeps crons out of local dev and other environments", () => {
		expect(config.triggers).toBeUndefined();
	});
});

describe("production environment config (#23)", () => {
	it("is not the demo, so the nightly reset can never run here", () => {
		expect(production.vars).toEqual({ DEMO: "false" });
	});

	it("binds its own database, never the demo's", () => {
		expect(production.d1_databases).toHaveLength(1);
		expect(production.d1_databases[0]).toMatchObject({
			binding: "DB",
			database_name: "tally-production",
			database_id: "97a4d15e-58a4-4067-b74e-6101195c6493",
			migrations_dir: "migrations",
		});
		expect(production.d1_databases[0].database_id).not.toBe(
			demo.d1_databases[0].database_id,
		);
	});

	it("is served only at tally.thesuperhuman.us, never finance.*", () => {
		expect(production.routes).toEqual([
			{ pattern: "tally.thesuperhuman.us", custom_domain: true },
		]);
		expect(production.workers_dev).toBe(false);
		expect(production.preview_urls).toBe(false);
		expect(JSON.stringify(production)).not.toContain("finance.");
	});

	it("syncs every bank daily at 09:00 UTC, and sorts what's left at 09:30 (decision 56)", () => {
		expect(production.triggers).toEqual({ crons: ["0 9 * * *", "30 9 * * *"] });
	});

	it("binds Workers AI for merchant names (#33) in production and the demo, not in local development", () => {
		expect(production.ai).toEqual({ binding: "AI" });
		expect(demo.ai).toEqual({ binding: "AI" });
		expect(config.ai).toBeUndefined();
	});

	it("holds no secrets or Plaid settings; those go in with wrangler secret put", () => {
		expect(JSON.stringify(production)).not.toMatch(
			/plaid|secret|token|jev|access_aud|team_domain/i,
		);
	});
});

describe("stripJsoncComments", () => {
	it("keeps // and /* inside strings, and drops real comments anywhere", () => {
		const text =
			'{ "url": "https://a/*b*/", // trailing\n /* block */ "n": 1 }';
		expect(JSON.parse(stripJsoncComments(text))).toEqual({
			url: "https://a/*b*/",
			n: 1,
		});
	});
});
