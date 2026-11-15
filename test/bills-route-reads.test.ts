import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// The bill save checks a new name against the bills that are active: a name another active bill has is refused, and
// a name only an inactive bill has is not. The check reads the active bills on each save, so the read's filter is
// pinned here at the route.

const BASE = "http://tally.test";
const today = todayIn(DEFAULT_TIME_ZONE);

const post = (path: string, fields: Record<string, string>) => {
	const body = new FormData();

	for (const [key, value] of Object.entries(fields)) body.append(key, value);

	return exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: { Origin: BASE, "HX-Request": "true" },
		body,
	});
};

const words = async (res: Response) =>
	(await res.text()).replaceAll("&#39;", "'");

const NEW_BILL = {
	amount: "12.50",
	frequency: "monthly",
	due_day: "5",
	category_id: "1",
	merchant_raw_name: "DUMP CO",
};

beforeEach(async () => {
	await resetDemo(env.DB, today);
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,active) VALUES(9601,'Taken Active',1000,5,'monthly','TAKEN A',1)",
		),
		env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,active) VALUES(9602,'Taken Off',1000,5,'monthly','TAKEN O',0)",
		),
	]);
});

describe("the name check reads only active bills", () => {
	it("refuses a name an active bill already has", async () => {
		const res = await post("/bills", { ...NEW_BILL, name: "taken ACTIVE" });

		// The sentence names the bill as it is saved, not as the person typed it.
		expect(await words(res)).toContain(
			"You already have a bill called Taken Active.",
		);
	});

	it("does not refuse a name only an inactive bill has", async () => {
		const res = await post("/bills", { ...NEW_BILL, name: "Taken Off" });

		expect(await words(res)).not.toContain("You already have a bill called");
	});
});
