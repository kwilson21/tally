import { type Context, Hono } from "hono";
import { matchBillPayments } from "../bills/match";
import {
	type BillStatus,
	billOccurrence,
	billOccurrenceForMonth,
} from "../bills/status";
import { todayUtc } from "../dates";
import { centsToAmount, formatCents, toCents } from "../money";
import { tidyName } from "../transactions/tidy-name";
import { BillOccurrenceRow } from "../views/bill-occurrence-row";
import { BillPaymentPicker } from "../views/bill-payment-picker";
import {
	BillRow,
	type BillRowData,
	BillStatusHeading,
} from "../views/bill-row";
import { BottomSheet } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import { MoneyInput } from "../views/money-input";
import { TextInput } from "../views/text-input";

type App = { Bindings: Env };
export const bills = new Hono<App>();

type DbBill = {
	id: number;
	name: string;
	amount_cents: number;
	due_day: number;
	frequency: "monthly" | "yearly";
	anchor_month: number | null;
	category_id: number | null;
	merchant_raw_name: string;
	active: number;
	icon: string | null;
	color: string | null;
	payment_period?: string | null;
	payment_date?: string | null;
};
type Category = { id: number; name: string; icon: string; color: string };
type Values = {
	name: string;
	amount: string;
	due_day: string;
	frequency: "monthly" | "yearly";
	anchor_month: string;
	category_id: string;
	merchant_raw_name: string;
};

function previousMonth(today: string) {
	const year = Number(today.slice(0, 4));
	const month = Number(today.slice(5, 7));
	return month === 1
		? `${year - 1}-12`
		: `${year}-${String(month - 1).padStart(2, "0")}`;
}

export async function loadBillRows(db: D1Database, today = todayUtc()) {
	const rows = await db
		.prepare(
			`SELECT b.*, c.icon, c.color, bp.period AS payment_period, t.date AS payment_date
			 FROM bills b
			 LEFT JOIN categories c ON c.id=b.category_id
			 LEFT JOIN bill_payments bp ON bp.bill_id=b.id AND bp.status='linked'
			   AND (bp.period >= ? OR (length(bp.period)=4 AND bp.period >= ?))
			 LEFT JOIN transactions t ON t.id=bp.transaction_id
			 ORDER BY b.id`,
		)
		// Only the periods billOccurrence can pick: last month on, or last year on.
		.bind(previousMonth(today), String(Number(today.slice(0, 4)) - 1))
		.all<DbBill>();
	const result: (BillRowData & { active: boolean })[] = [];
	const byBill = new Map<number, DbBill[]>();
	for (const row of rows.results) {
		const list = byBill.get(row.id);
		if (list) list.push(row);
		else byBill.set(row.id, [row]);
	}
	for (const billRows of byBill.values()) {
		const b = billRows[0] as DbBill;
		const payments = new Map(
			billRows
				.filter((row) => row.payment_period && row.payment_date)
				.map((row) => [
					row.payment_period as string,
					row.payment_date as string,
				]),
		);
		const occurrence = billOccurrence(
			{
				frequency: b.frequency,
				dueDay: b.due_day,
				anchorMonth: b.anchor_month,
			},
			today,
			new Set(payments.keys()),
		);
		result.push({
			id: b.id,
			name: b.name,
			amountCents: b.amount_cents,
			status: occurrence.status,
			dueDate: occurrence.dueDate,
			paidDate: payments.get(occurrence.period),
			icon: b.icon ?? "bills",
			color: b.color ?? "",
			active: !!b.active,
		});
	}
	return { today, rows: result };
}

const sheetAttrs = (href: string) => ({
	"hx-get": href,
	"hx-target": "#sheet",
	"hx-select": "#sheet",
	"hx-swap": "outerHTML",
	"hx-push-url": "true",
});

async function page(
	c: Context<App>,
	sheet?: { bill?: DbBill; values?: Values; errors?: Record<string, string> },
) {
	const { today, rows } = await loadBillRows(c.env.DB);
	const active = rows.filter((b) => b.active);
	const inactive = rows.filter((b) => !b.active);
	const soon = active.filter(
		(b) => b.status === "due" || b.status === "overdue",
	);
	return c.html(
		<Layout
			title="Bills · Tally"
			active="bills"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path}
		>
			<div class="max-w-2xl">
				<h1 class="font-serif text-4xl font-semibold tracking-tight">Bills</h1>
				<p class="mt-2 font-serif text-lg italic">
					{soon.length} {soon.length === 1 ? "bill" : "bills"} to pay soon,{" "}
					{formatCents(soon.reduce((n, b) => n + b.amountCents, 0))} in all
				</p>
				<div class="mt-3">
					<Button
						kind="secondary"
						href="/bills/new"
						{...sheetAttrs("/bills/new")}
					>
						Add a bill
					</Button>
				</div>
				{rows.length === 0 ? (
					<EmptyState
						kind="add"
						sentence="No bills yet."
						hint="Add a bill to see what needs paying."
					/>
				) : (
					(["overdue", "due", "upcoming", "paid"] as BillStatus[]).map(
						(status) => {
							const group = active.filter((b) => b.status === status);
							if (!group.length) return null;
							return (
								<section class="mt-4">
									<BillStatusHeading status={status} />
									<ul class="divide-y divide-rule">
										{group.map((bill) => (
											<BillRow
												bill={bill}
												today={today}
												href={`/bills/${bill.id}`}
											/>
										))}
									</ul>
								</section>
							);
						},
					)
				)}
				{inactive.length > 0 && (
					<details class="mt-2 border-t border-rule">
						<summary class="flex min-h-11 cursor-pointer items-center text-accent">
							Inactive ({inactive.length})
						</summary>
						<ul class="divide-y divide-rule">
							{inactive.map((bill) => (
								<BillRow bill={bill} today={today} href={`/bills/${bill.id}`} />
							))}
						</ul>
					</details>
				)}
			</div>
			<div id="sheet">
				{sheet && <BillSheet {...sheet} categories={await categories(c)} />}
			</div>
		</Layout>,
	);
}

async function categories(c: Context<App>) {
	return (
		await c.env.DB.prepare(
			"SELECT id,name,icon,color FROM categories WHERE archived=0 ORDER BY sort_order,name",
		).all<Category>()
	).results;
}
async function dbBill(c: Context<App>, id: number) {
	return c.env.DB.prepare(
		`SELECT b.*,c.icon,c.color FROM bills b LEFT JOIN categories c ON c.id=b.category_id WHERE b.id=?`,
	)
		.bind(id)
		.first<DbBill>();
}
function valuesOf(b?: DbBill): Values {
	return {
		name: b?.name ?? "",
		amount: b ? centsToAmount(b.amount_cents) : "",
		due_day: String(b?.due_day ?? ""),
		frequency: b?.frequency ?? "monthly",
		anchor_month: String(b?.anchor_month ?? 1),
		category_id: String(b?.category_id ?? ""),
		merchant_raw_name: b?.merchant_raw_name ?? "",
	};
}

function BillSheet({
	bill,
	values = valuesOf(bill),
	errors = {},
	categories,
}: {
	bill?: DbBill;
	values?: Values;
	errors?: Record<string, string>;
	categories: Category[];
}) {
	const action = bill ? `/bills/${bill.id}` : "/bills";
	return (
		<BottomSheet labelledBy="bill-sheet-title" closeHref="/bills">
			<h2
				id="bill-sheet-title"
				class="font-serif text-4xl font-semibold tracking-tight"
				tabindex={-1}
				autofocus
			>
				{bill ? bill.name : "Add a bill"}
			</h2>
			<form
				method="post"
				action={action}
				hx-post={action}
				hx-target="body"
				hx-swap="outerHTML"
				class="bill-form flex flex-col gap-3"
			>
				<TextInput
					id="bill-name"
					name="name"
					label="Name"
					value={values.name}
					error={errors.name}
					surface="paper"
					required
				/>
				<MoneyInput
					id="bill-amount"
					name="amount"
					label="Amount"
					value={values.amount}
					error={errors.amount}
				/>
				<div class="flex flex-wrap items-end gap-3">
					<TextInput
						id="bill-day"
						name="due_day"
						label="Due day"
						value={values.due_day}
						error={errors.due_day}
						surface="paper"
						class="w-24"
						inputmode="numeric"
						required
					/>
					<fieldset class="bill-frequency">
						<legend>How often</legend>
						<div class="mt-1 flex gap-2">
							<Chip
								type="radio"
								name="frequency"
								value="monthly"
								checked={values.frequency === "monthly"}
							>
								Monthly
							</Chip>
							<Chip
								type="radio"
								name="frequency"
								value="yearly"
								checked={values.frequency === "yearly"}
							>
								Yearly
							</Chip>
						</div>
					</fieldset>
				</div>
				<label class="bill-month flex-col gap-1">
					<span>Month (for yearly bills)</span>
					<select
						name="anchor_month"
						class="min-h-11 rounded-control border border-rule bg-paper px-3"
					>
						{Array.from({ length: 12 }, (_, i) => (
							<option
								value={i + 1}
								selected={values.anchor_month === String(i + 1)}
							>
								{new Intl.DateTimeFormat("en-US", {
									month: "long",
									timeZone: "UTC",
								}).format(new Date(Date.UTC(2026, i, 1)))}
							</option>
						))}
					</select>
					{errors.anchor_month && (
						<span role="alert" class="text-sm text-over">
							{errors.anchor_month}
						</span>
					)}
				</label>
				<fieldset>
					<legend>Category</legend>
					<div class="mt-1 flex flex-wrap gap-2">
						{categories.map((cat) => (
							<Chip
								type="radio"
								name="category_id"
								value={String(cat.id)}
								checked={values.category_id === String(cat.id)}
								icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
							>
								{cat.name}
							</Chip>
						))}
					</div>
					{errors.category_id && (
						<p role="alert" class="text-sm text-over">
							{errors.category_id}
						</p>
					)}
				</fieldset>
				<TextInput
					id="bill-merchant"
					name="merchant_raw_name"
					label="Paid to (the bank's text)"
					value={values.merchant_raw_name}
					error={errors.merchant_raw_name}
					surface="paper"
					required
				/>
				<div class="flex items-center justify-between gap-3">
					<div class="flex gap-3">
						<Button href="/bills" kind="secondary">
							Cancel
						</Button>
						<Button type="submit" busyLabel="Saving…">
							Save
						</Button>
					</div>
					{bill && (
						<Button
							kind="text"
							type="submit"
							formaction={`/bills/${bill.id}/${bill.active ? "deactivate" : "reactivate"}`}
							hx-post={`/bills/${bill.id}/${bill.active ? "deactivate" : "reactivate"}`}
						>
							{bill.active ? "Deactivate" : "Reactivate"}
						</Button>
					)}
				</div>
			</form>
		</BottomSheet>
	);
}

bills.get("/bills", (c) => page(c));
bills.get("/bills/new", (c) => page(c, {}));
bills.get("/bills/:id", async (c) => billPage(c, Number(c.req.param("id"))));
bills.get("/bills/:id/edit", async (c) => {
	const bill = await dbBill(c, Number(c.req.param("id")));
	return bill ? page(c, { bill }) : c.notFound();
});

async function save(c: Context<App>, id?: number) {
	const form = await c.req.parseBody();
	const raw = (name: string) => String(form[name] ?? "").trim();
	const values: Values = {
		name: raw("name"),
		amount: raw("amount"),
		due_day: raw("due_day"),
		frequency: raw("frequency") === "yearly" ? "yearly" : "monthly",
		anchor_month: raw("anchor_month"),
		category_id: raw("category_id"),
		merchant_raw_name: raw("merchant_raw_name"),
	};
	const errors: Record<string, string> = {};
	let cents = 0;
	try {
		cents = toCents(values.amount);
		if (cents <= 0) throw new Error();
	} catch {
		errors.amount = "Enter an amount greater than $0.";
	}
	const due = Number(values.due_day);
	if (!Number.isInteger(due) || due < 1 || due > 31)
		errors.due_day = "Enter a day from 1 to 31.";
	if (!values.name) errors.name = "Enter a name.";
	if (!values.merchant_raw_name)
		errors.merchant_raw_name = "Enter the bank's text.";
	if (!values.category_id) errors.category_id = "Choose a category.";
	else {
		const category = await c.env.DB.prepare(
			"SELECT id FROM categories WHERE id=? AND archived=0",
		)
			.bind(Number(values.category_id))
			.first();
		if (!category) errors.category_id = "Choose an existing category.";
	}
	const anchor = Number(values.anchor_month);
	if (
		values.frequency === "yearly" &&
		(!Number.isInteger(anchor) || anchor < 1 || anchor > 12)
	)
		errors.anchor_month = "Choose a month.";
	const bill = id ? await dbBill(c, id) : undefined;
	if (id && !bill) return c.notFound();
	if (Object.keys(errors).length)
		return page(c, { bill: bill ?? undefined, values, errors });
	const args = [
		values.name,
		cents,
		due,
		values.frequency,
		values.frequency === "yearly" ? Number(values.anchor_month) : null,
		Number(values.category_id),
		values.merchant_raw_name,
	];
	if (id) {
		const update = c.env.DB.prepare(
			"UPDATE bills SET name=?,amount_cents=?,due_day=?,frequency=?,anchor_month=?,category_id=?,merchant_raw_name=? WHERE id=?",
		).bind(...args, id);
		if (bill && bill.frequency !== values.frequency)
			// Period keys have different shapes (YYYY-MM vs YYYY), so neither links nor
			// dismissals remain meaningful after this schedule change.
			await c.env.DB.batch([
				update,
				c.env.DB.prepare("DELETE FROM bill_payments WHERE bill_id=?").bind(id),
			]);
		else await update.run();
	} else
		await c.env.DB.prepare(
			"INSERT INTO bills(name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name) VALUES(?,?,?,?,?,?,?)",
		)
			.bind(...args)
			.run();
	await matchBillPayments(c.env.DB);
	const message = id ? "Bill saved" : "Bill added";
	if (c.req.header("HX-Request")) {
		const res = await page(c);
		res.headers.set(
			"HX-Trigger",
			JSON.stringify({ toast: { message }, announce: message }),
		);
		res.headers.set("HX-Push-Url", "/bills");
		return res;
	}
	return c.redirect("/bills", 303);
}
bills.post("/bills", (c) => save(c));
bills.post("/bills/:id", (c) => save(c, Number(c.req.param("id"))));
for (const action of ["deactivate", "reactivate"] as const)
	bills.post(`/bills/:id/${action}`, async (c) => {
		const { meta } = await c.env.DB.prepare(
			"UPDATE bills SET active=? WHERE id=?",
		)
			.bind(action === "reactivate" ? 1 : 0, Number(c.req.param("id")))
			.run();
		if (!meta.changes) return c.notFound();
		const message =
			action === "reactivate" ? "Bill reactivated" : "Bill deactivated";
		if (c.req.header("HX-Request")) {
			const res = await page(c);
			res.headers.set(
				"HX-Trigger",
				JSON.stringify({ toast: { message }, announce: message }),
			);
			res.headers.set("HX-Push-Url", "/bills");
			return res;
		}
		return c.redirect("/bills", 303);
	});

type LinkedPayment = {
	period: string;
	transaction_id: number;
	matched_by: "auto" | "user";
	date: string;
	amount_cents: number;
	raw_name: string;
	display_name: string | null;
};
const monthName = (period: string) =>
	new Intl.DateTimeFormat("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${period}-01T00:00:00Z`));
const shortDate = (date: string) =>
	new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));
const ordinal = (day: number) =>
	`${day}${day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}`;
const addMonths = (period: string, amount: number) => {
	const date = new Date(`${period}-01T00:00:00Z`);
	date.setUTCMonth(date.getUTCMonth() + amount);
	return date.toISOString().slice(0, 7);
};
const occurrenceDate = (bill: DbBill, period: string) => {
	const month =
		bill.frequency === "monthly"
			? period
			: `${period}-${String(bill.anchor_month).padStart(2, "0")}`;
	return billOccurrenceForMonth(
		{
			frequency: bill.frequency,
			dueDay: bill.due_day,
			anchorMonth: bill.anchor_month,
		},
		Number(month.slice(0, 4)),
		Number(month.slice(5, 7)),
	).dueDate;
};
async function billPeriods(db: D1Database, bill: DbBill, today: string) {
	const first = await db
		.prepare(
			"SELECT MIN(period) AS period FROM bill_payments WHERE bill_id=? AND status='linked'",
		)
		.bind(bill.id)
		.first<{ period: string | null }>();
	const sixBack = addMonths(today.slice(0, 7), -6);
	let start = first?.period
		? first.period.length === 4
			? `${first.period}-${String(bill.anchor_month).padStart(2, "0")}`
			: first.period
		: sixBack;
	if (start < sixBack) start = sixBack;
	const upcoming = addMonths(
		today.slice(0, 7),
		bill.frequency === "yearly" ? 12 : 1,
	);
	const current = billOccurrence(
		{
			frequency: bill.frequency,
			dueDay: bill.due_day,
			anchorMonth: bill.anchor_month,
		},
		today,
		new Set(),
	).period;
	const end = bill.frequency === "yearly" ? upcoming.slice(0, 4) : upcoming;
	if (bill.frequency === "yearly") {
		const periods = Array.from(
			{ length: Math.max(0, Number(end) - Number(start.slice(0, 4)) + 1) },
			(_, i) => String(Number(end) - i),
		);
		if (!periods.includes(current)) periods.push(current);
		return periods.sort().reverse();
	}
	const result: string[] = [];
	for (let period = end; period >= start; period = addMonths(period, -1))
		result.push(period);
	if (!result.includes(current)) result.push(current);
	result.sort().reverse();
	return result;
}

async function billPage(
	c: Context<App>,
	id: number,
	pickerPeriod?: string,
	error?: string,
) {
	const bill = await dbBill(c, id);
	if (!bill) return c.notFound();
	const today = todayUtc();
	const periods = await billPeriods(c.env.DB, bill, today);
	if (pickerPeriod && !periods.includes(pickerPeriod)) return c.notFound();
	const payments = (
		await c.env.DB.prepare(
			`SELECT bp.period,bp.transaction_id,bp.matched_by,t.date,t.amount_cents,t.raw_name,m.display_name FROM bill_payments bp JOIN transactions t ON t.id=bp.transaction_id LEFT JOIN merchants m ON m.raw_name=t.raw_name WHERE bp.bill_id=? AND bp.status='linked'`,
		)
			.bind(id)
			.all<LinkedPayment>()
	).results;
	const byPeriod = new Map(
		payments.map((payment) => [payment.period, payment]),
	);
	let candidates: (LinkedPayment & { sameMerchant: number })[] = [];
	if (pickerPeriod) {
		const due = occurrenceDate(bill, pickerPeriod);
		candidates = (
			await c.env.DB.prepare(
				`SELECT t.id AS transaction_id,t.date,t.amount_cents,t.raw_name,m.display_name,CASE WHEN t.raw_name=? THEN 1 ELSE 0 END AS sameMerchant FROM transactions t LEFT JOIN merchants m ON m.raw_name=t.raw_name WHERE abs(julianday(t.date)-julianday(?))<=30 AND t.excluded=0 AND t.is_split=0 AND t.flag_income=0 AND NOT EXISTS(SELECT 1 FROM bill_payments bp WHERE bp.transaction_id=t.id AND bp.status='linked') AND NOT EXISTS(SELECT 1 FROM bill_payments dismissed WHERE dismissed.bill_id=? AND dismissed.period=? AND dismissed.transaction_id=t.id AND dismissed.status='dismissed') ORDER BY sameMerchant DESC, abs(t.amount_cents-?), abs(julianday(t.date)-julianday(?)), t.id`,
			)
				.bind(
					bill.merchant_raw_name,
					due,
					bill.id,
					pickerPeriod,
					bill.amount_cents,
					due,
				)
				.all<LinkedPayment & { sameMerchant: number }>()
		).results;
	}
	const current = billOccurrence(
		{
			frequency: bill.frequency,
			dueDay: bill.due_day,
			anchorMonth: bill.anchor_month,
		},
		today,
		new Set(payments.map((p) => p.period)),
	);
	return c.html(
		<Layout
			title={`${bill.name} · Tally`}
			active="bills"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path}
		>
			<div class="max-w-2xl">
				<a href="/bills" class="inline-flex min-h-11 items-center">
					Bills
				</a>
				<p class="text-sm text-muted">{bill.merchant_raw_name}</p>
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					{bill.name}
				</h1>
				<p class="text-lg">
					{formatCents(bill.amount_cents)}{" "}
					{bill.frequency === "monthly" ? "a month" : "a year"}, due the{" "}
					{ordinal(bill.due_day)}
				</p>
				{error && (
					<p role="alert" class="mt-3 text-over">
						{error}
					</p>
				)}
				<h2 class="mt-6 text-sm text-muted">Payments</h2>
				<ul class="divide-y divide-rule border-y border-rule">
					{periods.map((period) => {
						const payment = byPeriod.get(period);
						const due = occurrenceDate(bill, period);
						const status = payment
							? "paid"
							: period === current.period
								? current.status
								: due < today
									? "not-paid"
									: "upcoming";
						return (
							<BillOccurrenceRow
								billId={id}
								period={period}
								label={
									bill.frequency === "monthly" ? monthName(period) : period
								}
								status={status}
								payment={
									payment
										? {
												displayName:
													payment.display_name ?? tidyName(payment.raw_name),
												dateLabel: shortDate(payment.date),
												amountCents: payment.amount_cents,
												matchedBy: payment.matched_by,
											}
										: undefined
								}
							/>
						);
					})}
				</ul>
				<div class="mt-3">
					<Button
						kind="secondary"
						href={`/bills/${id}/edit`}
						{...sheetAttrs(`/bills/${id}/edit`)}
					>
						Edit bill
					</Button>
				</div>
				{pickerPeriod && (
					<BillPaymentPicker
						billId={id}
						billName={bill.name}
						billAmountCents={bill.amount_cents}
						openedPeriod={pickerPeriod}
						candidates={candidates.map((t) => ({
							id: t.transaction_id,
							displayName: t.display_name ?? tidyName(t.raw_name),
							dateLabel: shortDate(t.date),
							amountCents: t.amount_cents,
						}))}
						periods={periods
							.filter((period) => !byPeriod.has(period))
							.map((period) => ({
								value: period,
								label:
									bill.frequency === "monthly" ? monthName(period) : period,
							}))}
					/>
				)}
			</div>
			<div id="sheet" />
		</Layout>,
	);
}

bills.get("/bills/:id/occurrences/:period/link", (c) =>
	billPage(c, Number(c.req.param("id")), c.req.param("period")),
);
bills.post("/bills/:id/link", async (c) => {
	const id = Number(c.req.param("id"));
	const form = await c.req.parseBody();
	const transaction = Number(form.transaction_id);
	const period = String(form.period ?? "");
	const opened = String(form.opened_period ?? period);
	const bill = await dbBill(c, id);
	if (!bill) return c.notFound();
	if (
		!Number.isInteger(transaction) ||
		!(await billPeriods(c.env.DB, bill, todayUtc())).includes(period)
	)
		return billPage(c, id, opened, "Choose a payment and month.");
	const due = occurrenceDate(bill, period);
	const result = await c.env.DB.prepare(
		`INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT ?,?,?,'user','linked' WHERE EXISTS(SELECT 1 FROM transactions WHERE id=? AND excluded=0 AND is_split=0 AND flag_income=0 AND abs(julianday(date)-julianday(?))<=30)`,
	)
		.bind(id, period, transaction, transaction, due)
		.run();
	if (!result.meta.changes)
		return billPage(c, id, opened, "That payment is already linked.");
	return feedbackRedirect(c, id, "Payment linked");
});
bills.post("/bills/:id/occurrences/:period/unlink", async (c) => {
	const id = Number(c.req.param("id"));
	const period = c.req.param("period");
	const linked = await c.env.DB.prepare(
		"SELECT transaction_id FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
	)
		.bind(id, period)
		.first<{ transaction_id: number }>();
	if (!linked) return c.notFound();
	await c.env.DB.batch([
		c.env.DB.prepare(
			"DELETE FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
		).bind(id, period),
		c.env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status) VALUES(?,?,?,'user','dismissed')",
		).bind(id, period, linked.transaction_id),
	]);
	return feedbackRedirect(c, id, "Payment unlinked");
});
async function feedbackRedirect(c: Context<App>, id: number, message: string) {
	if (c.req.header("HX-Request")) {
		const response = await billPage(c, id);
		response.headers.set(
			"HX-Trigger",
			JSON.stringify({
				toast: { message, type: "success" },
				announce: message,
			}),
		);
		return response;
	}
	return c.redirect(`/bills/${id}`, 303);
}
