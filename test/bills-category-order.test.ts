import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// The bill sheet lists the categories the person can file a bill under: active ones only, in sort order and then by
// name. This pins that order on the page a new bill opens on, so the query behind it can change its form without
// changing what the person sees.

const BASE = "http://tally.test";
const today = todayIn(DEFAULT_TIME_ZONE);

beforeEach(async () => {
	await resetDemo(env.DB, today);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM categories"),
		// Sort order wins over name: Zulu (sort 1) comes before Alpha (sort 2). Ties fall back to name, so Bravo before Charlie.
		env.DB.prepare(
			"INSERT INTO categories(id,name,icon,color,sort_order,archived) VALUES(901,'Charlie Ord','cart','#111111',5,0)",
		),
		env.DB.prepare(
			"INSERT INTO categories(id,name,icon,color,sort_order,archived) VALUES(902,'Alpha Ord','cart','#111111',2,0)",
		),
		env.DB.prepare(
			"INSERT INTO categories(id,name,icon,color,sort_order,archived) VALUES(903,'Zulu Ord','cart','#111111',1,0)",
		),
		env.DB.prepare(
			"INSERT INTO categories(id,name,icon,color,sort_order,archived) VALUES(904,'Bravo Ord','cart','#111111',5,0)",
		),
		// Archived: not offered.
		env.DB.prepare(
			"INSERT INTO categories(id,name,icon,color,sort_order,archived) VALUES(905,'Gone Ord','cart','#111111',0,1)",
		),
	]);
});

describe("the bill sheet's category list", () => {
	it("offers active categories by sort order, then name, and leaves archived ones out", async () => {
		const res = await exports.default.fetch(`${BASE}/bills/new`, {
			headers: { Origin: BASE, "HX-Request": "true" },
		});

		const html = (await res.text()).replaceAll("&#39;", "'");

		// The chips are radio inputs named category_id; read their names in the order they are drawn.
		const offered = [
			...html.matchAll(/name="category_id"[^>]*>[\s\S]*?<\/label>/g),
		].flatMap((match) => {
			const name = /(\w+ Ord)/.exec(match[0])?.[1];

			return name ? [name] : [];
		});

		const ours = offered.filter((name) => /Ord$/.test(name));

		expect(ours).toEqual(["Zulu Ord", "Alpha Ord", "Bravo Ord", "Charlie Ord"]);
		expect(html).not.toContain("Gone Ord");
	});
});
