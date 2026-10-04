import { type Context, Hono } from "hono";
import { type BillStatus, billOccurrence } from "../bills/status";
import { todayUtc } from "../dates";
import { centsToAmount, formatCents, toCents } from "../money";
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

export async function loadBillRows(db: D1Database, today = todayUtc()) {
	const rows = await db
		.prepare(
			`SELECT b.*, c.icon, c.color, bp.period AS payment_period, t.date AS payment_date
			 FROM bills b
			 LEFT JOIN categories c ON c.id=b.category_id
			 LEFT JOIN bill_payments bp ON bp.bill_id=b.id AND bp.status='linked'
			 LEFT JOIN transactions t ON t.id=bp.transaction_id
			 ORDER BY b.id`,
		)
		.all<DbBill>();
	const result: (BillRowData & { active: boolean })[] = [];
	const byBill = new Map<number, DbBill[]>();
	for (const row of rows.results)
		byBill.set(row.id, [...(byBill.get(row.id) ?? []), row]);
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
												href={`/bills/${bill.id}/edit`}
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
								<BillRow
									bill={bill}
									today={today}
									href={`/bills/${bill.id}/edit`}
								/>
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
				<div class="grid gap-3 sm:grid-cols-2">
					<TextInput
						id="bill-day"
						name="due_day"
						label="Due day"
						value={values.due_day}
						error={errors.due_day}
						surface="paper"
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
					<Button type="submit" busyLabel="Saving…">
						Save
					</Button>
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
	if (id)
		await c.env.DB.prepare(
			"UPDATE bills SET name=?,amount_cents=?,due_day=?,frequency=?,anchor_month=?,category_id=?,merchant_raw_name=? WHERE id=?",
		)
			.bind(...args, id)
			.run();
	else
		await c.env.DB.prepare(
			"INSERT INTO bills(name,amount_cents,due_day,frequency,anchor_month,category_id,merchant_raw_name) VALUES(?,?,?,?,?,?,?)",
		)
			.bind(...args)
			.run();
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
		await c.env.DB.prepare("UPDATE bills SET active=? WHERE id=?")
			.bind(action === "reactivate" ? 1 : 0, Number(c.req.param("id")))
			.run();
		const message =
			action === "reactivate" ? "Bill reactivated" : "Bill deactivated";
		if (c.req.header("HX-Request")) {
			const res = await page(c);
			res.headers.set(
				"HX-Trigger",
				JSON.stringify({ toast: { message }, announce: message }),
			);
			return res;
		}
		return c.redirect("/bills", 303);
	});
