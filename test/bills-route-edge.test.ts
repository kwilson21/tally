import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// The bill routes read their id, payment and price inputs at the edge (#1006, plan 3). The first block pins today's
// answers for bad input; the last block pins the intended differences (a leading zero, a space, a sign, a decimal, a
// file part), which are the only answers that change.

const BASE = "http://tally.test";
const today = todayIn(DEFAULT_TIME_ZONE);
const PERIOD = today.slice(0, 7);
const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const BILL = 9400;

/** A form post; a field given as undefined is not sent at all. */
const post = (
	path: string,
	fields: Record<string, string | File | undefined> = {},
) => {
	const body = new FormData();

	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) body.append(key, value);
	}

	return exports.default.fetch(BASE + path, {
		method: "POST",
		redirect: "manual",
		headers: { Origin: BASE, "HX-Request": "true" },
		body,
	});
};

const get = (path: string) =>
	exports.default.fetch(BASE + path, {
		headers: { Origin: BASE, "HX-Request": "true" },
	});

/** A page's words as a person reads them: Hono writes an apostrophe as an entity. */
const words = async (res: Response) =>
	(await res.text()).replaceAll("&#39;", "'");

/** The toast an HTMX answer sends, or undefined when it sends none. */
const toastOf = (res: Response) => {
	// SAFETY: the HX-Trigger header a bill route sends is a JSON object, and its toast, when there is one, has these keys.
	const parsed = JSON.parse(res.headers.get("HX-Trigger") ?? "{}") as {
		toast?: { message: string; undoDone?: string };
	};

	return parsed.toast;
};

const linkedIds = async () =>
	(
		await env.DB.prepare(
			"SELECT transaction_id AS id FROM bill_payments WHERE bill_id=? AND period=? AND status='linked' ORDER BY id",
		)
			.bind(BILL, PERIOD)
			.all<{ id: number }>()
	).results.map((row) => row.id);

const billActive = async () =>
	(
		await env.DB.prepare("SELECT active FROM bills WHERE id=?")
			.bind(BILL)
			.first<{ active: number }>()
	)?.active;

/** The bill is due this month with payment 9401 linked, and 9403 is another payment in the window. */
beforeEach(async () => {
	await resetDemo(env.DB, today);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM bill_payments"),
		env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name) VALUES(?,'Gym',1500,?,'monthly','GYM CO')",
		).bind(BILL, Number(today.slice(8, 10))),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9401,id,?,1500,'GYM CO' FROM accounts WHERE type!='cash' LIMIT 1",
		).bind(today),
		env.DB.prepare(
			"INSERT INTO transactions(id,account_id,date,amount_cents,raw_name) SELECT 9403,id,?,1500,'GYM CO' FROM accounts WHERE type!='cash' LIMIT 1",
		).bind(today),
		env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,9401,'auto','linked')",
		).bind(BILL, PERIOD),
	]);
});

/** Nothing in the page's month changes: 9401 stays the only payment, and the bill stays on. */
const untouched = async () => {
	expect(await linkedIds()).toEqual([9401]);
	expect(await billActive()).toBe(1);
};

describe("a bill id that is not a number answers 404 and writes nothing", () => {
	// Every one of these is what the route answers today (the id is read as NaN or a number no bill has).
	const BAD_IDS = [
		"abc",
		"0",
		"-1",
		"1.5",
		"1e3",
		"0x1f",
		"99999999999999999999",
	];

	it.each(BAD_IDS)("answers 404 to every route for %s", async (id) => {
		const e = encodeURIComponent(id);
		const period = `/occurrences/${PERIOD}`;

		expect((await get(`/bills/${e}`)).status).toBe(404);
		expect((await get(`/bills/${e}/edit`)).status).toBe(404);
		expect((await post(`/bills/${e}/deactivate`)).status).toBe(404);
		expect((await post(`/bills/${e}/reactivate`)).status).toBe(404);
		expect(
			(
				await get(
					`/bills/${e}/month-explanation?period=${PERIOD}&transaction_id=9401`,
				)
			).status,
		).toBe(404);
		expect((await get(`/bills/${e}${period}/link`)).status).toBe(404);
		expect(
			(
				await post(`/bills/${e}/link`, {
					period: PERIOD,
					transaction_id: "9403",
				})
			).status,
		).toBe(404);
		expect(
			(await post(`/bills/${e}${period}/unlink`, { transaction_id: "9401" }))
				.status,
		).toBe(404);
		expect(
			(await post(`/bills/${e}/undo-unlink`, { token: `9401.${UUID}` })).status,
		).toBe(404);
		expect(
			(
				await post(`/bills/${e}${period}/price/accept`, {
					transaction_id: "9401",
				})
			).status,
		).toBe(404);
		expect(
			(
				await post(`/bills/${e}${period}/price/dismiss`, {
					transaction_id: "9401",
				})
			).status,
		).toBe(404);

		await untouched();
	});

	it("answers 200 to a good bill id, as it does today", async () => {
		expect((await get(`/bills/${BILL}`)).status).toBe(200);
		expect((await get(`/bills/${BILL}/edit`)).status).toBe(200);
	});
});

describe("unlink names one payment, and a bad one is no match", () => {
	it("unlinks the month's only payment when none is named", async () => {
		const res = await post(`/bills/${BILL}/occurrences/${PERIOD}/unlink`);

		expect(res.status).toBe(200);
		expect(toastOf(res)?.message).toBe("Payment unlinked");
		expect(await linkedIds()).toEqual([]);
	});

	it("unlinks the payment it names", async () => {
		const res = await post(`/bills/${BILL}/occurrences/${PERIOD}/unlink`, {
			transaction_id: "9401",
		});

		expect(res.status).toBe(200);
		expect(await linkedIds()).toEqual([]);
	});

	it.each([
		["empty", ""],
		["zero", "0"],
		["non-numeric", "abc"],
		["negative", "-1"],
		["decimal", "1.5"],
		["exponent", "1e3"],
		["a payment the month does not have", "9403"],
		["far past the safe range", "99999999999999999999"],
		["a file part", new File(["x"], "payment.txt")],
	])(
		"answers 404 and unlinks nothing when it names %s",
		async (_label, value) => {
			const res = await post(`/bills/${BILL}/occurrences/${PERIOD}/unlink`, {
				transaction_id: value,
			});

			expect(res.status).toBe(404);
			expect(await linkedIds()).toEqual([9401]);
		},
	);
});

describe("link with no payment chosen", () => {
	beforeEach(async () => {
		await env.DB.prepare("DELETE FROM bill_payments").run();
	});

	it("links the payment it names", async () => {
		const res = await post(`/bills/${BILL}/link`, {
			transaction_id: "9403",
			period: PERIOD,
			opened_period: PERIOD,
		});

		expect(toastOf(res)?.message).toBe("Payment linked");
		expect(await linkedIds()).toEqual([9403]);
	});

	it.each([
		["no payment", undefined],
		["an empty payment", ""],
		["zero", "0"],
		["non-numeric", "abc"],
		["negative", "-1"],
		["decimal", "1.5"],
		["a file part", new File(["x"], "payment.txt")],
	])("says none is chosen for %s, and links nothing", async (_label, value) => {
		const res = await post(`/bills/${BILL}/link`, {
			period: PERIOD,
			transaction_id: value,
		});

		expect(await words(res)).toContain("Choose a payment and month.");
		expect(await linkedIds()).toEqual([]);
	});
});

describe("the month's explanation with a payment that is absent or not a row", () => {
	it("explains the month when no payment is named", async () => {
		const res = await get(`/bills/${BILL}/month-explanation?period=${PERIOD}`);

		expect(res.status).toBe(200);
		expect(await words(res)).toContain(
			"A late payment counts in its bill's month",
		);
	});

	it.each([
		["empty", ""],
		["zero", "0"],
		["negative", "-1"],
		["far past the safe range", "99999999999999999999"],
	])("answers 404 for %s", async (_label, value) => {
		const res = await get(
			`/bills/${BILL}/month-explanation?period=${PERIOD}&transaction_id=${encodeURIComponent(value)}`,
		);

		expect(res.status).toBe(404);
	});
});

describe("the link picker with a payment that is not a row", () => {
	it.each([
		["empty", ""],
		["zero", "0"],
		["non-numeric", "abc"],
	])(
		"shows the picker as with no payment named, for %s",
		async (_label, value) => {
			const none = await words(
				await get(`/bills/${BILL}/occurrences/${PERIOD}/link`),
			);

			const named = await words(
				await get(
					`/bills/${BILL}/occurrences/${PERIOD}/link?transaction_id=${encodeURIComponent(value)}`,
				),
			);

			expect(named).toBe(none);
		},
	);
});

describe("a price change answered with a payment or prices that do not match", () => {
	const GONE = "That price change isn't on offer any more.";

	it.each([
		["absent", undefined],
		["empty", ""],
		["zero", "0"],
		["non-numeric", "abc"],
		["negative", "-1"],
		["decimal", "1.5"],
		["far past the safe range", "99999999999999999999"],
		["a file part", new File(["x"], "payment.txt")],
	])(
		"says the offer is gone for a payment that is %s",
		async (_label, value) => {
			for (const verb of ["accept", "dismiss"]) {
				const fields = {
					bill_cents: "1500",
					charge_cents: "1500",
					current_cents: "1500",
					transaction_id: value,
				};

				const res = await post(
					`/bills/${BILL}/occurrences/${PERIOD}/price/${verb}`,
					fields,
				);

				expect(res.status).toBe(200);
				expect(await words(res)).toContain(GONE);
			}

			await untouched();
		},
	);
});

describe("an Undo with a token that is not a held Undo", () => {
	it.each([
		["empty", ""],
		["a word", "x"],
		["a short UUID", "9401.short"],
		["a trailing space", `9401.${UUID} `],
		["a payment id that is not a row", `abc.${UUID}`],
		["a payment id with a leading zero", `007.${UUID}`],
		["a non-hex character", `9401.${UUID.slice(0, 35)}g`],
	])(
		"says the Undo expired and echoes the token as posted, for %s",
		async (_label, token) => {
			const res = await post(`/bills/${BILL}/undo-unlink`, { token });

			expect(res.status).toBe(200);
			expect(toastOf(res)).toEqual({
				message: "Undo expired.",
				type: "error",
				undoDone: token,
			});
			await untouched();
		},
	);
});

describe("intended differences (#1006, plan 3)", () => {
	it.each([
		["a leading zero", `0${BILL}`],
		["a leading space", ` ${BILL}`],
		["a plus sign", `+${BILL}`],
		["a decimal point", `${BILL}.0`],
	])(
		"answers 404 to the bill's page for %s, as a bad id does",
		async (_label, id) => {
			const e = encodeURIComponent(id);

			expect((await get(`/bills/${e}`)).status).toBe(404);
			expect((await post(`/bills/${e}/deactivate`)).status).toBe(404);
			await untouched();
		},
	);

	it("refuses a payment id with a leading zero when unlinking, as RowId refuses it", async () => {
		const res = await post(`/bills/${BILL}/occurrences/${PERIOD}/unlink`, {
			transaction_id: "009401",
		});

		expect(res.status).toBe(404);
		expect(await linkedIds()).toEqual([9401]);
	});

	it("refuses a payment id with a leading zero when linking, as no choice", async () => {
		await env.DB.prepare("DELETE FROM bill_payments").run();

		const res = await post(`/bills/${BILL}/link`, {
			transaction_id: "009403",
			period: PERIOD,
		});

		expect(await words(res)).toContain("Choose a payment and month.");
		expect(await linkedIds()).toEqual([]);
	});

	it.each([
		["a leading zero", "007"],
		["non-numeric", "abc"],
		["a decimal", "1.5"],
	])(
		"answers 404 to the explanation for %s, as a refused id",
		async (_label, value) => {
			const res = await get(
				`/bills/${BILL}/month-explanation?period=${PERIOD}&transaction_id=${value}`,
			);

			expect(res.status).toBe(404);
		},
	);

	it("shows the picker with no payment named for a leading zero", async () => {
		const none = await words(
			await get(`/bills/${BILL}/occurrences/${PERIOD}/link`),
		);

		const named = await words(
			await get(`/bills/${BILL}/occurrences/${PERIOD}/link?transaction_id=007`),
		);

		expect(named).toBe(none);
	});

	it("says the bill page is not here, not that the Undo expired, for a bad bill id", async () => {
		const res = await post(`/bills/abc/undo-unlink`, {
			token: `9401.${UUID}`,
		});

		expect(res.status).toBe(404);
		expect(toastOf(res)?.message).toBe("This page isn't here.");
	});

	it("echoes an empty token for a file part, not the file's text", async () => {
		const res = await post(`/bills/${BILL}/undo-unlink`, {
			token: new File(["x"], "token.txt"),
		});

		expect(toastOf(res)).toEqual({
			message: "Undo expired.",
			type: "error",
			undoDone: "",
		});
	});
});
