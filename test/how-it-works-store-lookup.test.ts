import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { howItWorks } from "../src/routes/how-it-works";
import { envWith } from "./helpers/doubles";

// #988: How Tally works explains the store lookup, in the Categories section at #store-lookup (spec §7, §8.6).

const notDemo = envWith(env, { DEMO: "false" });
const demoEnv = envWith(env, { DEMO: "true" });

/** Undoes the HTML escaping Hono applies to text, for comparing with plain strings. */
const decodeHtml = (html: string) =>
	html
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");

const page = async (environment: typeof notDemo) =>
	decodeHtml(
		await (await howItWorks.request("/how-it-works", {}, environment)).text(),
	);

const sentences = [
	"Tally looks a store up on the web once, and keeps one short line about what kind of place it is, like “Coffee shop in Arlington, VA”.",
	"Only the store's name as your bank gives it is sent, with its numbers taken out.",
	"The line is used for two things: a second look at a category guess Tally wasn't sure of, and a suggested name for a store your bank didn't name.",
	"A guess made with it is never filed by itself; it waits as a Maybe for you.",
	"“Don't use this” under a line stops it for that store for good, and “Look up new stores on the web” in Settings stops it everywhere.",
];

describe("How Tally works explains the store lookup (#988)", () => {
	it("the Categories section holds the lookup's words at #store-lookup", async () => {
		const html = await page(notDemo);

		const section = html.indexOf('id="categorization"');
		const at = html.indexOf('id="store-lookup"');
		const next = html.indexOf("<section", section + 1);

		expect(section).toBeGreaterThan(-1);
		expect(at).toBeGreaterThan(section);
		expect(next === -1 || at < next).toBe(true);
		expect(at).toBeLessThan(html.indexOf("finds three or more", section));

		for (const sentence of sentences) expect(html).toContain(sentence);
	});

	it("the demo adds that it never searches, and the family app does not", async () => {
		expect(await page(demoEnv)).toContain(
			"The demo never searches; its few lines were written by hand.",
		);
		expect(await page(notDemo)).not.toContain("The demo never searches");
	});
});
