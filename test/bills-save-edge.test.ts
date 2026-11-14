import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

// The bill save form reads its fields and its address id at the edge (#1006, plan 7). Every answer below is what the
// route gives today, pinned before the change; the padded-id block is the one intended difference (a write path).

const BASE = "http://tally.test";
const today = todayIn(DEFAULT_TIME_ZONE);
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

/** A page's words as a person reads them: Hono writes an apostrophe as an entity. */
const words = async (res: Response) =>
	(await res.text()).replaceAll("&#39;", "'");

/** A new monthly bill that saves: every field a valid answer. */
const GOOD_NEW = {
	name: "Dump bill",
	amount: "12.50",
	frequency: "monthly",
	due_day: "5",
	category_id: "1",
	merchant_raw_name: "DUMP CO",
};

/** The seeded bill, with its own name and bank text, so it can be edited without a name clash. */
const GOOD_EDIT = {
	...GOOD_NEW,
	name: "Gym",
	merchant_raw_name: "GYM CO",
	amount: "15.00",
};

const file = () => new File(["x"], "field.txt");

const billCount = async () =>
	(
		await env.DB.prepare("SELECT COUNT(*) AS n FROM bills").first<{
			n: number;
		}>()
	)?.n;

const gym = async () =>
	env.DB.prepare(
		"SELECT name, amount_cents, due_day, frequency FROM bills WHERE id=?",
	)
		.bind(BILL)
		.first<{
			name: string;
			amount_cents: number;
			due_day: number;
			frequency: string;
		}>();

const savedNamed = async (name: string) =>
	env.DB.prepare(
		"SELECT amount_cents, due_day, frequency, anchor_month, anchor_date, category_id FROM bills WHERE name=?",
	)
		.bind(name)
		.first<{
			amount_cents: number;
			due_day: number;
			frequency: string;
			anchor_month: number | null;
			anchor_date: string | null;
			category_id: number;
		}>();

beforeEach(async () => {
	await resetDemo(env.DB, today);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM bill_payments"),
		env.DB.prepare("DELETE FROM bills WHERE id = ?").bind(BILL),
		env.DB.prepare(
			"INSERT INTO bills(id,name,amount_cents,due_day,frequency,merchant_raw_name,category_id) VALUES(?,'Gym',1500,5,'monthly','GYM CO',1)",
		).bind(BILL),
	]);
});

describe("the amount is a dollar amount above $0, at most the occurrence cap", () => {
	it.each([
		["empty", ""],
		["zero", "0"],
		["zero cents", "0.00"],
		["minus five", "-5"],
		["minus zero", "-0"],
		["a dollar sign and a minus", "-$5"],
		["a plus sign", "+5"],
		["a tenth of a cent", "0.001"],
		["letters", "abc"],
		["an exponent", "1e3"],
		["hex", "0x5"],
		["a dot with no cents", "5."],
		["a point with no whole part", ".5"],
		["a bad comma grouping", "1,2345"],
		["a space inside", "1 000"],
		["three decimals", "12.345"],
		["Infinity", "Infinity"],
		["a file part", file()],
	])("refuses %s with the greater-than sentence", async (_label, amount) => {
		const before = await billCount();
		const res = await post("/bills", { ...GOOD_NEW, amount });

		expect(res.status).toBe(200);
		expect(await words(res)).toContain("Enter an amount greater than $0.");
		expect(await billCount()).toBe(before);
	});

	it.each([
		["a whole number over the cap", "99999999999"],
		["just over the cap", "100000000.01"],
		["a huge number", "11111111111111111111"],
	])("refuses %s with the cap sentence", async (_label, amount) => {
		const before = await billCount();
		const res = await post("/bills", { ...GOOD_NEW, amount });

		expect(await words(res)).toContain(
			"Enter an amount of $100,000,000 or less.",
		);
		expect(await billCount()).toBe(before);
	});

	it("refuses an amount over $100,000 that is not confirmed, and saves it once confirmed", async () => {
		const res = await post("/bills", { ...GOOD_NEW, amount: "100000.01" });

		expect(await words(res)).toContain("is a lot for a bill.");
		expect(await savedNamed("Dump bill")).toBeNull();

		const confirmed = await post("/bills", {
			...GOOD_NEW,
			amount: "100000.01",
			confirm_amount: "10000001",
		});

		expect(confirmed.status).toBe(200);
		expect((await savedNamed("Dump bill"))?.amount_cents).toBe(10000001);
	});

	it.each([
		["a plain whole number", "5", 500],
		["a number with zeros in front", "0005", 500],
		["a dollar sign", "$5", 500],
		["a space around it", " 5 ", 500],
		["comma grouping", "1,240.18", 124018],
		["a million with commas", "100,000", 10000000],
	])("saves %s as %d cents", async (_label, amount, cents) => {
		const res = await post("/bills", { ...GOOD_NEW, amount });

		expect(res.status).toBe(200);
		expect((await savedNamed("Dump bill"))?.amount_cents).toBe(cents);
	});
});

describe("the day of a bill", () => {
	it.each([
		["empty", ""],
		["zero", "0"],
		["past the month", "32"],
		["minus one", "-1"],
		["a decimal", "5.5"],
		["letters", "abc"],
		["Infinity", "Infinity"],
		["a file part", file()],
	])("refuses a monthly day that is %s", async (_label, due_day) => {
		const res = await post("/bills", { ...GOOD_NEW, due_day });

		expect(await words(res)).toContain("Enter a day from 1 to 31.");
	});

	it.each([
		["07", 7],
		[" 5", 5],
		["5.0", 5],
		["1e1", 10],
		["0x5", 5],
		["0b101", 5],
	])(
		"reads the monthly day %s as the day %d, as Number does",
		async (due_day, day) => {
			const res = await post("/bills", {
				...GOOD_NEW,
				due_day,
				name: `Day ${due_day}`,
			});

			expect(res.status).toBe(200);
			expect((await savedNamed(`Day ${due_day}`))?.due_day).toBe(day);
		},
	);

	it.each([
		["empty", ""],
		["zero", "0"],
		["eight", "8"],
		["letters", "abc"],
		["a file part", file()],
	])("refuses a weekly day that is %s", async (_label, weekly_day) => {
		const res = await post("/bills", {
			...GOOD_NEW,
			frequency: "weekly",
			due_day: undefined,
			weekly_day,
		});

		expect(await words(res)).toContain("Choose a day of the week.");
	});

	it("reads a weekly day of 07 as the day 7, as Number does", async () => {
		await post("/bills", {
			...GOOD_NEW,
			frequency: "weekly",
			due_day: undefined,
			weekly_day: "07",
		});

		expect((await savedNamed("Dump bill"))?.due_day).toBe(7);
	});

	it.each(["", "2026-02-30", "2026-13-01", "2026-11-2", "abc"])(
		"refuses a biweekly bill whose date is %j with the date sentence",
		async (anchor_date) => {
			const res = await post("/bills", {
				...GOOD_NEW,
				frequency: "biweekly",
				due_day: undefined,
				anchor_date,
			});

			expect(await words(res)).toContain("Choose a date.");
		},
	);

	it("takes a biweekly bill's day from its date, whatever the day field says", async () => {
		const res = await post("/bills", {
			...GOOD_NEW,
			frequency: "biweekly",
			due_day: "abc",
			anchor_date: "2026-11-02",
		});

		expect(res.status).toBe(200);
		expect((await savedNamed("Dump bill"))?.anchor_date).toBe("2026-11-02");
	});
});

describe("the month of a yearly or quarterly bill", () => {
	it.each([
		["yearly", "yearly"],
		["quarterly", "quarterly"],
	])(
		"refuses a %s bill with no month, or one out of range",
		async (_label, frequency) => {
			for (const anchor_month of ["", "0", "13", "abc", "Infinity"]) {
				const res = await post("/bills", {
					...GOOD_NEW,
					frequency,
					anchor_month,
				});

				expect(await words(res)).toContain("Choose a month.");
			}
		},
	);

	it.each([
		["07", 7],
		["2.0", 2],
		["0x2", 2],
		["1e1", 10],
		[" 3", 3],
	])(
		"reads the month %s as %d, as Number does",
		async (anchor_month, month) => {
			const res = await post("/bills", {
				...GOOD_NEW,
				frequency: "yearly",
				anchor_month,
				name: `Month ${anchor_month}`,
			});

			expect(res.status).toBe(200);
			expect((await savedNamed(`Month ${anchor_month}`))?.anchor_month).toBe(
				month,
			);
		},
	);
});

describe("the category and the name and bank text", () => {
	it("says Choose a category. when none is chosen", async () => {
		const res = await post("/bills", { ...GOOD_NEW, category_id: "" });

		expect(await words(res)).toContain("Choose a category.");
	});

	it.each(["abc", "999", "-1", "99999999999999999999"])(
		"says Choose an existing category. for %s",
		async (category_id) => {
			const res = await post("/bills", { ...GOOD_NEW, category_id });

			expect(await words(res)).toContain("Choose an existing category.");
		},
	);

	it("says Enter a name. and Enter the bank's text. together when both are blank", async () => {
		const res = await post("/bills", {
			...GOOD_NEW,
			name: "",
			merchant_raw_name: "",
		});

		const page = await words(res);

		expect(page).toContain("Enter a name.");
		expect(page).toContain("Enter the bank's text.");
	});

	it("saves a file posted as the name as the bill's name, as it always has", async () => {
		await post("/bills", { ...GOOD_NEW, name: file() });

		expect(await savedNamed("[object File]")).not.toBeNull();
	});
});

describe("the id in the address", () => {
	it.each(["abc", "0", "1e3", "0x1f", "99999999999999999999", "9999"])(
		"answers 404 to a save of bill %s and writes nothing",
		async (id) => {
			const before = await billCount();
			const res = await post(`/bills/${encodeURIComponent(id)}`, GOOD_EDIT);

			expect(res.status).toBe(404);
			expect(await billCount()).toBe(before);
			expect((await gym())?.name).toBe("Gym");
		},
	);

	it("saves an edit of the bill the address names", async () => {
		const res = await post(`/bills/${BILL}`, GOOD_EDIT);

		expect(res.status).toBe(200);
		expect(await gym()).toMatchObject({ name: "Gym", amount_cents: 1500 });
	});

	it("answers the form's own sentence for a bad field on a good id, as today", async () => {
		const res = await post(`/bills/${BILL}`, { ...GOOD_EDIT, amount: "abc" });

		expect(res.status).toBe(200);
		expect(await words(res)).toContain("Enter an amount greater than $0.");
		expect((await gym())?.amount_cents).toBe(1500);
	});
});

describe("an address id that is not plain digits is refused (an intended difference)", () => {
	// Today "009400", "+9400" and "9400.0" edit bill 9400 (Number reads them as 9400). The row-id edge refuses them
	// as it refuses any id that is not plain digits, so the save answers 404 and writes nothing.
	it.each(["009400", "+9400", "9400.0", "9400%20"])(
		"answers 404 to a save of %s and changes nothing",
		async (id) => {
			const res = await post(`/bills/${id}`, GOOD_EDIT);

			expect(res.status).toBe(404);
			expect(await gym()).toMatchObject({ name: "Gym", amount_cents: 1500 });
		},
	);
});
