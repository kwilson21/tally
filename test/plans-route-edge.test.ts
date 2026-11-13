import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, monthsBefore, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { PLAN_NAME_MAX } from "../src/limits";
import { PlanMovedOrPaid, PlanUndoExpired } from "../src/rules/plans";

// Characterisation of the plan routes and the Undo routes with bad input (#1006, plan 2). The answers pinned here are
// today's; the only ones that change are listed under "intended differences" at the end of the file.

const BASE = "http://tally.test";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const MONTH = TODAY.slice(0, 7);
const LAST_MONTH = monthsBefore(MONTH, 1);
const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
	await env.DB.prepare("DELETE FROM planned_expenses").run();
});

const headers = (htmx: boolean) => {
	const h = new Headers({ Origin: BASE });

	if (htmx) h.set("HX-Request", "true");

	return h;
};

const get = (path: string) =>
	exports.default.fetch(BASE + path, { headers: headers(true) });

const post = (path: string, fields: Record<string, string>) =>
	exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: headers(true),
		body: new URLSearchParams(fields),
	});

/** A form with file parts as well as text: a file is what a field posted as a file part looks like to the route. */
const postForm = (path: string, fields: Record<string, string | File>) => {
	const form = new FormData();

	for (const [key, value] of Object.entries(fields)) form.append(key, value);

	return exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: headers(true),
		body: form,
	});
};

/** The toast an HTMX answer sends (HX-Trigger), or undefined when it sends none. */
type ToastOut = {
	message: string;
	type: string;
	undoDone?: string;
	undo?: string;
};

const toastOf = (res: Response): ToastOut | undefined => {
	const header = res.headers.get("HX-Trigger");

	if (!header) return undefined;

	// SAFETY: the HX-Trigger header a route sends is a JSON object, and its toast, when there is one, has these keys.
	const parsed = JSON.parse(header) as { toast?: ToastOut };

	return parsed.toast;
};

/** A page's words as a person reads them: Hono writes an apostrophe as an entity. */
const words = async (res: Response) =>
	(await res.text()).replaceAll("&#39;", "'");

async function plan(
	name: string,
	amountCents: number,
	month: string,
	transactionId: number | null = null,
) {
	const row = await env.DB.prepare(
		"INSERT INTO planned_expenses(name,amount_cents,month,transaction_id,created_by) VALUES(?,?,?,?,'demo') RETURNING id",
	)
		.bind(name, amountCents, month, transactionId)
		.first<{ id: number }>();

	return row?.id ?? 0;
}

async function payment(id: number, amountCents: number) {
	await env.DB.prepare(
		"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT ?,id,?,?,'DMV FIXTURE' FROM accounts WHERE type!='cash' LIMIT 1",
	)
		.bind(id, `${MONTH}-05`, amountCents)
		.run();

	return id;
}

const countPlans = async () =>
	(
		await env.DB.prepare("SELECT COUNT(*) AS n FROM planned_expenses").first<{
			n: number;
		}>()
	)?.n;

const planRow = (id: number) =>
	env.DB.prepare(
		"SELECT name, amount_cents AS amountCents, month, transaction_id AS transactionId FROM planned_expenses WHERE id=?",
	)
		.bind(id)
		.first<{
			name: string;
			amountCents: number;
			month: string;
			transactionId: number | null;
		}>();

describe("a plan id that is not one of the app's own ids", () => {
	// Every answer here is a 404, and nothing is read into the page or written: the plan beside them stays as it is.
	const BAD_IDS = ["abc", "0", "-1", "1.5", "1e3", "99999999999999999999"];

	it.each(BAD_IDS)("answers 404 to GET for %s", async (id) => {
		const plan404 = await plan("Gym", 1200, MONTH);

		expect((await get(`/plans/${id}`)).status).toBe(404);
		expect((await get(`/plans/${id}/edit`)).status).toBe(404);
		expect((await get(`/plans/${id}/delete`)).status).toBe(404);
		expect((await planRow(plan404))?.name).toBe("Gym");
	});

	it.each(BAD_IDS)(
		"answers 404 to every POST for %s and writes nothing",
		async (id) => {
			const keep = await plan("Gym", 1200, MONTH);

			const answers = [
				await post(`/plans/${id}/link`, { transaction_id: "1" }),
				await post(`/plans/${id}/unlink`, {}),
				await post(`/plans/${id}/delete`, {}),
				await post(`/plans/${id}/drop`, {}),
				await post(`/plans/${id}`, {
					name: "Renamed",
					amount: "5",
					month: MONTH,
				}),
			];

			expect(answers.map((res) => res.status)).toEqual([
				404, 404, 404, 404, 404,
			]);
			expect(await countPlans()).toBe(1);
			expect((await planRow(keep))?.name).toBe("Gym");
		},
	);

	it("moves nothing for a plan that is not there: the rule's toast answers, as it does today", async () => {
		const res = await post("/plans/999999/move", {});

		expect(toastOf(res)).toEqual({
			message: new PlanMovedOrPaid().say,
			type: "error",
		});
	});

	it("answers Delete of a plan that is already gone with a 404 (no toast)", async () => {
		const gone = await post("/plans/999999/delete", {});

		expect(gone.status).toBe(404);
	});

	it("answers the plan's page for a plan that exists", async () => {
		const id = await plan("Gym", 1200, MONTH);
		const res = await get(`/plans/${id}`);

		expect(res.status).toBe(200);
		expect(await words(res)).toContain("Gym");
	});
});

describe("a link's transaction_id that is not a payment's id", () => {
	// Today every one of these is read as 0 and refused by the rule, the same answer as a 0 (decision 82).
	it.each([
		["abc", "abc"],
		["minus five", "-5"],
		["a fraction", "1.5"],
		["empty", ""],
		["NaN", "NaN"],
	])("answers %s as 0 does, and links nothing", async (_label, text) => {
		const id = await plan("Gym", 1200, MONTH);
		await payment(987041, 1200);

		const asZero = await post(`/plans/${id}/link`, { transaction_id: "0" });
		const asBad = await post(`/plans/${id}/link`, { transaction_id: text });

		expect(asBad.status).toBe(asZero.status);
		expect(await words(asBad)).toBe(await words(asZero));
		expect((await planRow(id))?.transactionId).toBeNull();
	});

	it("answers a file part posted as transaction_id as 0 does", async () => {
		const id = await plan("Gym", 1200, MONTH);
		const asZero = await post(`/plans/${id}/link`, { transaction_id: "0" });

		const asFile = await postForm(`/plans/${id}/link`, {
			transaction_id: new File(["41"], "id.txt"),
		});

		expect(await words(asFile)).toBe(await words(asZero));
		expect((await planRow(id))?.transactionId).toBeNull();
	});

	it("answers a missing transaction_id as 0 does", async () => {
		const id = await plan("Gym", 1200, MONTH);
		const asZero = await post(`/plans/${id}/link`, { transaction_id: "0" });
		const missing = await post(`/plans/${id}/link`, {});

		expect(await words(missing)).toBe(await words(asZero));
	});

	it("links a real payment to a plan", async () => {
		const id = await plan("Gym", 1200, MONTH);
		await payment(987042, 1200);

		const res = await post(`/plans/${id}/link`, { transaction_id: "987042" });

		expect(toastOf(res)).toEqual({
			message: "Payment linked",
			type: "success",
		});
		expect((await planRow(id))?.transactionId).toBe(987042);
	});
});

describe("the Undo token of a plan's delete", () => {
	const EXPIRED = new PlanUndoExpired().say;

	it("restores a held delete with its own token", async () => {
		const id = await plan("Car registration", 18000, MONTH);
		const deleted = toastOf(await post(`/plans/${id}/delete`, {}));
		const token = deleted?.undo ?? "";

		expect(token).toMatch(/^[0-9a-f-]{36}$/);
		const res = await post("/plans/undo-delete", { token });

		expect(toastOf(res)).toEqual({
			message: "Restored Car registration.",
			type: "success",
			undoDone: token,
		});
	});

	it.each([
		["a word", "abc"],
		["empty", ""],
		["35 characters", UUID.slice(0, 35)],
		["37 characters", `${UUID}0`],
		["a space in place of a dash", UUID.replace("-", " ")],
		["a trailing newline", `${UUID}\n`],
		["non-hex letters", UUID.replace("3f2b", "zzzz")],
	])("refuses %s as an expired Undo, and echoes it", async (_label, token) => {
		const res = await post("/plans/undo-delete", { token });

		expect(toastOf(res)).toEqual({
			message: EXPIRED,
			type: "error",
			undoDone: token,
		});
	});

	it("refuses a file part posted as token as an expired Undo, with no undoDone", async () => {
		const res = await postForm("/plans/undo-delete", {
			token: new File([UUID], "token.txt"),
		});

		expect(toastOf(res)).toEqual({ message: EXPIRED, type: "error" });
	});

	it("refuses a missing token as an expired Undo, with no undoDone", async () => {
		const res = await post("/plans/undo-delete", {});

		expect(toastOf(res)).toEqual({ message: EXPIRED, type: "error" });
	});

	it("refuses a well-formed token nothing holds as an expired Undo", async () => {
		const res = await post("/plans/undo-delete", { token: UUID });

		expect(toastOf(res)).toEqual({
			message: EXPIRED,
			type: "error",
			undoDone: UUID,
		});
	});
});

describe("the plan sheet's fields, checked before the write", () => {
	const SAY_FOR = "Say what it's for.";
	const KEEP_SHORT = `Keep the name under ${PLAN_NAME_MAX} characters.`;
	const GREATER = "Enter an amount greater than $0.";
	const SMALLER = "Enter a smaller amount in dollars and cents.";
	const MONTH_CHOICE = "Choose a month.";

	const create = (fields: Record<string, string>) => post("/plans", fields);

	it("saves a good plan, trimmed, and says what it made", async () => {
		const res = await create({
			name: "  Gym  ",
			amount: "12.50",
			month: MONTH,
		});

		expect(toastOf(res)).toEqual({
			message: "Planned Gym, $12.50.",
			type: "success",
		});
		expect(await countPlans()).toBe(1);
	});

	it.each([
		["an empty name", { name: "", amount: "12", month: MONTH }, SAY_FOR],
		["a blank name", { name: "   ", amount: "12", month: MONTH }, SAY_FOR],
		[
			"a name over the limit",
			{ name: "x".repeat(PLAN_NAME_MAX + 1), amount: "12", month: MONTH },
			KEEP_SHORT,
		],
		["an amount of abc", { name: "Gym", amount: "abc", month: MONTH }, GREATER],
		["an amount of 0", { name: "Gym", amount: "0", month: MONTH }, GREATER],
		["an amount of -5", { name: "Gym", amount: "-5", month: MONTH }, GREATER],
		[
			"an amount of 9e99",
			{ name: "Gym", amount: "9e99", month: MONTH },
			GREATER,
		],
		["an empty amount", { name: "Gym", amount: "", month: MONTH }, GREATER],
		[
			"an amount too large to hold in cents",
			{ name: "Gym", amount: "9999999999999999", month: MONTH },
			SMALLER,
		],
		[
			"a month not on offer",
			{ name: "Gym", amount: "12", month: "2001-01" },
			MONTH_CHOICE,
		],
		[
			"a month a year on",
			{ name: "Gym", amount: "12", month: monthsBefore(MONTH, -12) },
			MONTH_CHOICE,
		],
	])(
		"refuses %s with its sentence and saves nothing",
		async (_label, fields, sentence) => {
			const res = await create(fields);

			expect(res.status).toBe(200);
			expect(toastOf(res)).toBeUndefined();
			expect(await words(res)).toContain(sentence);
			expect(await countPlans()).toBe(0);
		},
	);

	it("says every wrong field's sentence at once", async () => {
		const html = await words(
			await create({ name: "", amount: "abc", month: "2001-01" }),
		);

		expect(html).toContain(SAY_FOR);
		expect(html).toContain(GREATER);
		expect(html).toContain(MONTH_CHOICE);
	});

	it("echoes the typed-and-trimmed values back to the sheet", async () => {
		const html = await words(
			await create({ name: "  Rent  ", amount: " abc ", month: MONTH }),
		);

		expect(html).toContain('value="Rent"');
		expect(html).toContain('value="abc"');
	});

	it("keeps a file part posted as the name as its text, as it does today", async () => {
		const res = await postForm("/plans", {
			name: new File(["Gym"], "name.txt"),
			amount: "12",
			month: MONTH,
		});

		expect(toastOf(res)).toEqual({
			message: "Planned [object File], $12.00.",
			type: "success",
		});
	});

	it("refuses a file part posted as the amount with the amount sentence", async () => {
		const res = await postForm("/plans", {
			name: "Gym",
			amount: new File(["12"], "amount.txt"),
			month: MONTH,
		});

		expect(await words(res)).toContain(GREATER);
		expect(await countPlans()).toBe(0);
	});

	it("refuses a file part posted as the month with the month sentence", async () => {
		const res = await postForm("/plans", {
			name: "Gym",
			amount: "12",
			month: new File([MONTH], "month.txt"),
		});

		expect(await words(res)).toContain(MONTH_CHOICE);
		expect(await countPlans()).toBe(0);
	});

	it("keeps a plan's own earlier month on offer when it is saved", async () => {
		const id = await plan("Gym", 1200, LAST_MONTH);

		const res = await post(`/plans/${id}`, {
			name: "Edited",
			amount: "9",
			month: LAST_MONTH,
		});

		expect(toastOf(res)).toEqual({ message: "Saved Edited.", type: "success" });
		expect((await planRow(id))?.month).toBe(LAST_MONTH);
	});

	it("refuses an earlier month on a plan whose own month is not earlier", async () => {
		const id = await plan("Gym", 1200, MONTH);

		const res = await post(`/plans/${id}`, {
			name: "Edited",
			amount: "9",
			month: LAST_MONTH,
		});

		expect(await words(res)).toContain(MONTH_CHOICE);
		expect((await planRow(id))?.name).toBe("Gym");
	});

	it("refuses a save's bad amount, and leaves the plan as it was", async () => {
		const id = await plan("Gym", 1200, MONTH);

		const res = await post(`/plans/${id}`, {
			name: "Edited",
			amount: "0",
			month: MONTH,
		});

		expect(await words(res)).toContain(GREATER);
		expect(await planRow(id)).toEqual({
			name: "Gym",
			amountCents: 1200,
			month: MONTH,
			transactionId: null,
		});
	});
});

// The intended differences (#1006, plan 2). Each one fails on the code before the edge and passes after it:
//   1. an id or transaction_id written with a leading zero (or any form but plain digits) is refused, as #1053 refuses it;
//   2. a plan's Move with an id that is not a number answers 404 before the rule runs.
describe("intended differences: ids that are not plain digits", () => {
	it("answers 404 to a plan id with a leading zero, though the plan 7 is there", async () => {
		await env.DB.prepare(
			"INSERT INTO planned_expenses(id,name,amount_cents,month,created_by) VALUES(7,'Gym',1200,?,'demo')",
		)
			.bind(MONTH)
			.run();

		expect((await get("/plans/7")).status).toBe(200);
		expect((await get("/plans/007")).status).toBe(404);
	});

	it("answers 404 to Move with an id that is not a number, and moves nothing", async () => {
		const keep = await plan("Gym", 1200, MONTH);
		const res = await post("/plans/abc/move", {});

		// The app's not-found toast, as every bad id's answer is (error-pages.tsx), not the rule's "already moved or paid".
		expect(res.status).toBe(404);
		expect(toastOf(res)).toEqual({
			message: "This page isn't here.",
			type: "error",
		});
		expect((await planRow(keep))?.month).toBe(MONTH);
	});

	it("refuses a transaction_id with a leading zero as 0 does, and links nothing", async () => {
		const id = await plan("Gym", 1200, MONTH);
		await payment(987042, 1200);

		const asZero = await post(`/plans/${id}/link`, { transaction_id: "0" });

		const asPadded = await post(`/plans/${id}/link`, {
			transaction_id: "0987042",
		});

		expect(await words(asPadded)).toBe(await words(asZero));
		expect((await planRow(id))?.transactionId).toBeNull();
	});
});
