import { toCents } from "../money";

export type CashValues = {
	date: string;
	amount: string;
	merchant: string;
	category: string;
	note: string;
};
export type CashErrors = Partial<Record<keyof CashValues, string>>;

export function parseCash(
	values: CashValues,
	today: string,
	categoryIds: number[],
) {
	const errors: CashErrors = {};
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(values.date);
	const realDate =
		match !== null &&
		new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
			.toISOString()
			.slice(0, 10) === values.date;
	if (!realDate || values.date > today)
		errors.date = "Choose today or an earlier date.";
	let cents = 0;
	try {
		cents = toCents(values.amount);
		if (!Number.isSafeInteger(cents))
			errors.amount = "Enter a smaller amount in dollars and cents.";
		else if (cents <= 0) errors.amount = "Enter an amount greater than zero.";
	} catch {
		errors.amount = "Enter an amount in dollars and cents.";
	}
	const merchant = values.merchant.trim();
	if (!merchant) errors.merchant = "Enter where you spent it.";
	else if (merchant.length > 120)
		errors.merchant = "Use 120 characters or fewer.";
	const categoryId = Number(values.category);
	if (!categoryIds.includes(categoryId))
		errors.category = "Pick a category from the list.";
	if (values.note.length > 500) errors.note = "Use 500 characters or fewer.";
	return Object.keys(errors).length
		? { ok: false as const, errors }
		: {
				ok: true as const,
				value: {
					date: values.date,
					amountCents: cents,
					merchant,
					categoryId,
					note: values.note.trim() || null,
				},
			};
}

/** Creates the guarded local account and transaction in one D1 batch. */
export async function saveCash(
	db: D1Database,
	value: {
		date: string;
		amountCents: number;
		merchant: string;
		categoryId: number;
		note: string | null;
	},
	by: string,
) {
	await db.batch([
		db.prepare(
			"INSERT INTO accounts (name,type) VALUES ('Cash','cash') ON CONFLICT(type) WHERE type='cash' DO NOTHING",
		),
		db
			.prepare(`INSERT INTO transactions (account_id,date,amount_cents,raw_name,category_id,category_source,flag_income,note,updated_by)
			VALUES ((SELECT id FROM accounts WHERE type='cash'),?,?,?,?, 'user',?,?,?)`)
			.bind(
				value.date,
				value.amountCents,
				value.merchant,
				value.categoryId,
				0,
				value.note,
				by,
			),
	]);
}
