import { type Context, Hono } from "hono";
import {
	type AmountRow,
	amountForMonth,
	earlierAmount,
	latestPriceChange,
} from "../bills/amount";
import { type BillSuggestion, loadBillSuggestions } from "../bills/find";
import {
	BIG_BILL_CENTS,
	duplicateBillName,
	needsBigAmountConfirm,
	sameBillName,
} from "../bills/guards";
import { matchBillPayments } from "../bills/match";
import {
	acceptPriceOffer,
	dismissPriceOffer,
	findPriceOffer,
	loadPriceOffers,
	type PriceOffer,
} from "../bills/price-change";
import { liftNotThisOneSql } from "../bills/split-dismissals";
import {
	type BillStatus,
	billCadenceLabel,
	billOccurrence,
	billOccurrenceForMonth,
	billOccurrencesForMonth,
	handledBeforeAdded,
	manualLinkWindowDays,
	occurrencePaid,
} from "../bills/status";
import { type BillTotalFrequency, billTotalsForRows } from "../bills/totals";
import {
	activateBill,
	type BillFields,
	insertBill,
	updateBill,
} from "../bills/write";
import {
	daysBefore,
	householdToday,
	monthLabel,
	ordinal,
	shortDay,
} from "../dates";
import { amountRowsByBill } from "../db/bill-amounts";
import { billPeriodMonth, type CountedBill } from "../db/counted-month";
import {
	isMerchantTextSql,
	merchantColumnSql,
	merchantKeyOfBankText,
	merchantTextArgs,
} from "../db/merchant-key";
import { ownNameSql } from "../db/own-name";
import { centsToAmount, formatCents, toCents } from "../money";
import { tidyName } from "../transactions/tidy-name";
import { AppliesNote, PriceChangeLine } from "../views/bill-amount-history";
import { BillFindingBand, BillFindingRow } from "../views/bill-finding";
import { BillOccurrenceRow } from "../views/bill-occurrence-row";
import {
	BillMonthExplanation,
	BillPaymentPicker,
	paymentCountSentence,
} from "../views/bill-payment-picker";
import {
	BillMonthlyTotal,
	BillRow,
	type BillRowData,
	BillStatusHeading,
} from "../views/bill-row";
import { BottomSheet } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
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
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	anchor_month: number | null;
	anchor_date: string | null;
	category_id: number | null;
	merchant_raw_name: string;
	merchant_raw_text: number;
	active: number;
	added_on: string | null;
	icon: string | null;
	color: string | null;
	payment_period?: string | null;
	payment_date?: string | null;
	payment_amount_cents?: number | null;
};
type Category = { id: number; name: string; icon: string; color: string };
/** An amount over $100,000.00 that the form asks about with a "Yes, $X is right" chip (P45 A). */
type BigAmount = { cents: number; confirmed: boolean };
type Values = {
	name: string;
	amount: string;
	due_day: string;
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	anchor_month: string;
	anchor_date: string;
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

const validDateString = (date: string) =>
	/^\d{4}-\d{2}-\d{2}$/.test(date) &&
	!Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
	new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** Every bill with its status, as of `today`: the household's date, read once by the request. */
export async function loadBillRows(db: D1Database, today: string) {
	const rows = await db
		.prepare(
			`SELECT b.*, c.icon, c.color, bp.period AS payment_period, t.date AS payment_date, t.amount_cents AS payment_amount_cents
			 FROM bills b
			 LEFT JOIN categories c ON c.id=b.category_id
			 LEFT JOIN bill_payments bp ON bp.bill_id=b.id AND bp.status='linked'
			   AND (bp.period >= ? OR (length(bp.period)=4 AND bp.period >= ?) OR (b.frequency='quarterly' AND bp.period >= ?))
			 LEFT JOIN transactions t ON t.id=bp.transaction_id
			 ORDER BY b.id`,
		)
		// Only the periods billOccurrence can pick: last month on, or last year on.
		.bind(
			previousMonth(today),
			String(Number(today.slice(0, 4)) - 1),
			`${Number(today.slice(0, 4)) - 1}-Q1`,
		)
		.all<DbBill>();
	const result: (BillRowData & {
		active: boolean;
		/** The bill's own current amount (`bills.amount_cents`), which its monthly share reads. */
		currentAmountCents: number;
		frequency: BillTotalFrequency;
		paidCents: number;
		totalOccurrences: {
			dueDate: string;
			status: BillStatus;
			amountCents: number;
			paidCents: number;
		}[];
		nextOccurrence?: {
			dueDate: string;
			status: BillStatus;
			amountCents: number;
			paidCents: number;
		};
		/** The occurrence the row shows, as bill_payments keys it, and the merchant it's matched on. */
		period: string;
		merchantRawName: string;
		merchantRawText: number;
	})[] = [];
	const byBill = new Map<number, DbBill[]>();
	for (const row of rows.results) {
		const list = byBill.get(row.id);
		if (list) list.push(row);
		else byBill.set(row.id, [row]);
	}
	const amounts = await amountRowsByBill(db);
	// An occurrence's status in the month's totals: paid once its payments reach 90%, else overdue, due within seven
	// days, or upcoming. A part-paid occurrence keeps the status its date gives it (decision 101).
	const occurrenceStatus = (dueDate: string, paid: boolean): BillStatus =>
		paid
			? "paid"
			: dueDate < today
				? "overdue"
				: dueDate <= daysBefore(today, -7)
					? "due"
					: "upcoming";
	for (const billRows of byBill.values()) {
		const b = billRows[0] as DbBill;
		// An occurrence's amount is the one of its own month (decision 101); see src/bills/amount.ts.
		const amountHistory = amounts.get(b.id) ?? [];
		const amountOf = (dueDate: string) =>
			amountForMonth(amountHistory, dueDate.slice(0, 7), b.amount_cents);
		// The latest payment's date, which a Paid occurrence's row shows.
		const payments = new Map<string, string>();
		for (const row of billRows) {
			if (!row.payment_period || !row.payment_date) continue;
			if ((payments.get(row.payment_period) ?? "") < row.payment_date)
				payments.set(row.payment_period, row.payment_date);
		}
		const paymentsByPeriod = new Map<string, number>();
		for (const row of billRows) {
			if (!row.payment_period) continue;
			paymentsByPeriod.set(
				row.payment_period,
				(paymentsByPeriod.get(row.payment_period) ?? 0) +
					Math.max(0, row.payment_amount_cents ?? 0),
			);
		}
		const paidPeriods = paidPeriodsOf(b, amountHistory, paymentsByPeriod);
		const occurrence = billOccurrence(
			{
				frequency: b.frequency,
				dueDay: b.due_day,
				anchorMonth: b.anchor_month,
				anchorDate: b.anchor_date,
				addedOn: b.added_on,
			},
			today,
			paidPeriods,
			new Set(payments.keys()),
		);
		const totalOccurrences = [
			{
				dueDate: occurrence.dueDate,
				status: occurrence.status,
				amountCents: amountOf(occurrence.dueDate),
				paidCents: paymentsByPeriod.get(occurrence.period) ?? 0,
			},
		];
		const monthOccurrences = billOccurrencesForMonth(
			{
				frequency: b.frequency,
				dueDay: b.due_day,
				anchorMonth: b.anchor_month,
				anchorDate: b.anchor_date,
			},
			Number(today.slice(0, 4)),
			Number(today.slice(5, 7)),
		);
		for (const current of monthOccurrences)
			if (
				!handledBeforeAdded(
					b.added_on,
					current.dueDate,
					payments.has(current.period),
				) &&
				!totalOccurrences.some((item) => item.dueDate === current.dueDate)
			) {
				totalOccurrences.push({
					dueDate: current.dueDate,
					status: occurrenceStatus(
						current.dueDate,
						paidPeriods.has(current.period),
					),
					amountCents: amountOf(current.dueDate),
					paidCents: paymentsByPeriod.get(current.period) ?? 0,
				});
			}
		// A weekly or every-two-weeks bill's next occurrence is set aside once it falls due, even when it is in
		// next month (an unpaid Friday on Oct 30 with Nov 6 due in a week). Only that one is needed beyond the month.
		const stepDays =
			b.frequency === "weekly" ? 7 : b.frequency === "biweekly" ? 14 : 0;
		const nextDue = stepDays ? daysBefore(occurrence.dueDate, -stepDays) : "";
		const nextOccurrence =
			nextDue && !nextDue.startsWith(today.slice(0, 7))
				? {
						dueDate: nextDue,
						status: occurrenceStatus(nextDue, paidPeriods.has(nextDue)),
						amountCents: amountOf(nextDue),
						paidCents: paymentsByPeriod.get(nextDue) ?? 0,
					}
				: undefined;
		result.push({
			id: b.id,
			name: b.name,
			// The shown occurrence's amount: the Bills row, its status and its set-aside totals read this. The
			// monthly share reads currentAmountCents instead.
			amountCents: amountOf(occurrence.dueDate),
			currentAmountCents: b.amount_cents,
			status: occurrence.status,
			dueDate: occurrence.dueDate,
			paidDate: payments.get(occurrence.period),
			icon: b.icon ?? "bills",
			color: b.color ?? "",
			active: !!b.active,
			period: occurrence.period,
			merchantRawName: b.merchant_raw_name,
			merchantRawText: b.merchant_raw_text,
			frequency: b.frequency,
			dueDay: b.due_day,
			anchorMonth: b.anchor_month,
			paidCents: paymentsByPeriod.get(occurrence.period) ?? 0,
			totalOccurrences,
			nextOccurrence,
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

// `given` is the household's date when the handler already read it, so a request reads it once.
async function page(
	c: Context<App>,
	sheet?: {
		bill?: DbBill;
		values?: Values;
		errors?: Record<string, string>;
		bigAmount?: BigAmount;
	},
	given?: string,
) {
	const today = given ?? (await householdToday(c.env.DB));
	const { rows: loaded } = await loadBillRows(c.env.DB, today);
	const suggestions = await loadBillSuggestions(c.env.DB, today);
	// A payment at another price is offered on the row it would pay: an active bill whose shown
	// occurrence is unpaid, due or overdue (P36 B, spec §8.5). Worked out here each time; nothing is stored.
	const offers = await loadPriceOffers(c.env.DB, loaded);
	const rows = loaded.map((b) => {
		const offer = offers.get(b.id);
		return offer
			? {
					...b,
					priceOffer: { amountCents: offer.amountCents, date: offer.date },
				}
			: b;
	});
	const active = rows.filter((b) => b.active);
	const inactive = rows.filter((b) => !b.active);
	const totals = billTotalsForRows(today.slice(0, 7), active);
	return c.html(
		<Layout
			title="Bills · Tally"
			active="bills"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path}
		>
			<div class="max-w-2xl">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">Bills</h1>
				{rows.length > 0 && (
					<p class="mt-2 font-serif text-lg italic">
						{totals.soonCount} {totals.soonCount === 1 ? "bill" : "bills"} to
						pay soon, {formatCents(totals.soonCents)} in all
					</p>
				)}
				{rows.length > 0 && (
					<BillMonthlyTotal
						monthlyCents={totals.monthlyCents}
						stillToPayCents={totals.stillToPayCents}
						month={today.slice(0, 7)}
					/>
				)}
				<HowLink section="bills" />
				<div class="mt-3">
					<Button
						kind="secondary"
						href="/bills/new"
						{...sheetAttrs("/bills/new")}
					>
						Add a bill
					</Button>
				</div>
				<BillFindingBand count={suggestions.length} />
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
									<BillStatusHeading
										status={status}
										totalCents={
											totals.groups[
												`${status === "paid" ? "paid" : status}Cents`
											]
										}
									/>
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
					<details class="group mt-2 border-t border-rule">
						<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 text-accent [&::-webkit-details-marker]:hidden">
							<span class="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none">
								<Icon name="chevron-right" class="size-5" />
							</span>
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
				{sheet && (
					<BillSheet
						{...sheet}
						categories={await categories(c)}
						today={today}
						keptCents={
							sheet.bill
								? await earlierPrice(c.env.DB, sheet.bill.id, today)
								: undefined
						}
					/>
				)}
			</div>
		</Layout>,
	);
}

/**
 * The price earlier months keep, when the bill has an earlier price (decision 101): what the edit sheet
 * names under its amount, or undefined so the line is left out. Month is this month, as a change applies from it.
 */
async function earlierPrice(db: D1Database, billId: number, today: string) {
	const history = (await amountRowsByBill(db, billId)).get(billId) ?? [];
	return earlierAmount(history, today.slice(0, 7));
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
async function activeBills(c: Context<App>) {
	return (
		await c.env.DB.prepare(
			"SELECT id,name,active FROM bills WHERE active=1",
		).all<{ id: number; name: string; active: number }>()
	).results;
}
/** The sheet again, with the Name error for a name another active bill has (`values.name` is the name). */
async function nameTaken(
	c: Context<App>,
	sheet: { bill?: DbBill; values: Values; bigAmount?: BigAmount },
) {
	const name = sheet.values.name;
	const taken = duplicateBillName(await activeBills(c), name, sheet.bill?.id);
	// Whoever held the name may have let go of it already; the person is still told it was taken.
	return page(c, { ...sheet, errors: { name: alreadyCalled(taken ?? name) } });
}
const alreadyCalled = (name: string) =>
	`You already have a bill called ${name}.`;
function valuesOf(b?: DbBill): Values {
	return {
		name: b?.name ?? "",
		amount: b ? centsToAmount(b.amount_cents) : "",
		due_day: String(b?.due_day ?? ""),
		frequency: b?.frequency ?? "monthly",
		anchor_month: String(b?.anchor_month ?? 1),
		anchor_date: b?.anchor_date ?? "",
		category_id: String(b?.category_id ?? ""),
		merchant_raw_name: b?.merchant_raw_name ?? "",
	};
}

function quarterlyMonths(anchorMonth: string) {
	const first = Math.min(12, Math.max(1, Number(anchorMonth) || 1)) - 1;
	return [0, 3, 6, 9].map((offset) =>
		new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
			new Date(Date.UTC(2026, (first + offset) % 12, 1)),
		),
	);
}

function BillSheet({
	bill,
	values = valuesOf(bill),
	errors = {},
	bigAmount,
	categories,
	today,
	keptCents,
}: {
	bill?: DbBill;
	values?: Values;
	errors?: Record<string, string>;
	bigAmount?: BigAmount;
	categories: Category[];
	today: string;
	/** The price earlier months keep, when the bill had one (see earlierPrice); the note is left out otherwise. */
	keptCents?: number;
}) {
	const action = bill ? `/bills/${bill.id}` : "/bills";
	// Once a name has been refused, Reactivate also sends the Name field, so renaming the bill is how
	// to get it back (P45 A's duplicate name has no other way out).
	const activeAction = bill
		? `${action}/${bill.active ? "deactivate" : `reactivate${errors.name ? "?rename=1" : ""}`}`
		: "";
	return (
		// A field's error draws the open sheet again.
		<BottomSheet
			labelledBy="bill-sheet-title"
			closeHref="/bills"
			still={Object.keys(errors).length > 0}
		>
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
				<div>
					<MoneyInput
						id="bill-amount"
						name="amount"
						label="Amount"
						value={values.amount}
						error={errors.amount}
					/>
					{/* Only a bill with an earlier price says what earlier months keep (decision 101). */}
					{keptCents !== undefined && (
						<AppliesNote
							month={monthLabel(today.slice(0, 7), today)}
							keptCents={keptCents}
						/>
					)}
				</div>
				{bigAmount && (
					<div class="flex justify-center">
						{/* Its value is the cents it confirms, so a changed amount isn't covered by it. Ticked
						    already (another field needed fixing): the alert line is gone, so nothing to describe. */}
						<Chip
							type="checkbox"
							name="confirm_amount"
							value={String(bigAmount.cents)}
							checked={bigAmount.confirmed}
							describedBy={
								bigAmount.confirmed ? undefined : "bill-amount-error"
							}
						>
							{`Yes, ${formatCents(bigAmount.cents)} is right`}
						</Chip>
					</div>
				)}
				<div class="flex flex-wrap items-end gap-3">
					<label class="bill-weekday flex flex-col gap-1">
						<span>Day of the week</span>
						<select
							name="weekly_day"
							class="min-h-11 rounded-control border border-rule bg-paper px-3"
						>
							{[
								"Monday",
								"Tuesday",
								"Wednesday",
								"Thursday",
								"Friday",
								"Saturday",
								"Sunday",
							].map((day, i) => (
								<option
									value={i + 1}
									selected={values.due_day === String(i + 1)}
								>
									{day}
								</option>
							))}
						</select>
						{values.frequency === "weekly" && errors.due_day && (
							<span role="alert" class="text-sm text-over">
								{errors.due_day}
							</span>
						)}
					</label>
					<div class="bill-due-day">
						<TextInput
							id="bill-day"
							name="due_day"
							label="Due day"
							value={values.due_day}
							error={values.frequency === "weekly" ? undefined : errors.due_day}
							surface="paper"
							class="w-24"
							inputmode="numeric"
						/>
					</div>
					<fieldset class="bill-frequency">
						<legend>How often</legend>
						<div class="mt-1 flex flex-wrap gap-2">
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
							{(["weekly", "biweekly", "quarterly"] as const).map(
								(frequency) => (
									<Chip
										type="radio"
										name="frequency"
										value={frequency}
										checked={values.frequency === frequency}
									>
										{frequency === "biweekly"
											? "Every two weeks"
											: frequency === "weekly"
												? "Weekly"
												: "Quarterly"}
									</Chip>
								),
							)}
						</div>
						{errors.frequency && (
							<p role="alert" class="mt-1 text-sm text-over">
								{errors.frequency}
							</p>
						)}
					</fieldset>
				</div>
				<label class="bill-month flex-col gap-1">
					<span class="bill-year-label">Month (for yearly bills)</span>
					<span class="bill-quarter-label">First month</span>
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
					<span class="bill-quarter-hint text-sm text-muted">
						{"Then every 3 months: " +
							quarterlyMonths(values.anchor_month)
								.join(", ")
								.replace(/, ([^,]+)$/, " and $1") +
							"."}
					</span>
				</label>
				<div class="bill-anchor-date">
					<TextInput
						id="bill-anchor-date"
						name="anchor_date"
						label="A date it was paid"
						type="date"
						value={values.anchor_date}
						error={errors.anchor_date}
						hint={
							values.anchor_date && validDateString(values.anchor_date)
								? `Then every two weeks from that date. Next: ${shortDate(nextTwoWeeksAfter(values.anchor_date, today))}.`
								: "Then every two weeks from that date."
						}
						surface="paper"
					/>
				</div>
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
							formaction={activeAction}
							hx-post={activeAction}
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
bills.get("/bills/new", (c) => {
	const q = c.req.query();
	const values = q.name
		? {
				name: q.name,
				amount: q.amount ?? "",
				due_day: q.due_day ?? "",
				frequency: "monthly" as const,
				anchor_month: "1",
				anchor_date: "",
				category_id: q.category_id ?? "",
				merchant_raw_name: q.merchant_raw_name ?? "",
			}
		: undefined;
	return page(c, { values });
});
bills.get("/bills/find", async (c) => {
	const suggestions = await loadBillSuggestions(
		c.env.DB,
		await householdToday(c.env.DB),
	);
	return c.html(
		<Layout
			title="Possible bills · Tally"
			active="bills"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path}
		>
			<div class="max-w-2xl">
				<a href="/bills" class="inline-flex min-h-11 items-center">
					Bills
				</a>
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					Possible bills
				</h1>
				<HowLink section="bills" />
				<p class="mt-2 text-muted">
					About the same amount, about a month apart. Nothing becomes a bill
					until you add it.
				</p>
				{billFindingList(suggestions)}
			</div>
		</Layout>,
	);
});
function billFindingList(suggestions: BillSuggestion[], focusRawName?: string) {
	return suggestions.length ? (
		<ul
			id="bill-finding-list"
			class="mt-4 divide-y divide-rule border-y border-rule"
		>
			{suggestions.map((suggestion) => (
				<BillFindingRow
					suggestion={suggestion}
					focusAdd={suggestion.rawName === focusRawName}
				/>
			))}
		</ul>
	) : (
		<div id="bill-finding-list">
			<h2 tabindex={-1} autofocus={focusRawName != null} class="sr-only">
				Possible bills review complete
			</h2>
			<EmptyState
				kind="done"
				sentence="No possible bills to review."
				hint="New repeat charges will appear here."
			/>
		</div>
	);
}
bills.post("/bills/find/:merchant/dismiss", async (c) => {
	// Hono has already decoded the name once.
	const merchant = c.req.param("merchant");
	const today = await householdToday(c.env.DB);
	const before = await loadBillSuggestions(c.env.DB, today);
	const dismissedIndex = before.findIndex((row) => row.rawName === merchant);
	if (dismissedIndex < 0) return c.notFound();
	const result = await c.env.DB.prepare(
		`INSERT INTO merchants(raw_name,not_a_bill) VALUES(?,1)
		 ON CONFLICT(raw_name) DO UPDATE SET not_a_bill=1`,
	)
		.bind(merchant)
		.run();
	if (!result.meta.changes) return c.notFound();
	const headers = {
		"HX-Trigger": JSON.stringify({
			toast: { message: "Marked as not a bill", type: "success" },
			announce: "Suggestion removed",
		}),
	};
	if (c.req.header("HX-Request")) {
		const remaining = await loadBillSuggestions(c.env.DB, today);
		const focus = remaining[dismissedIndex] ?? remaining[0];
		return c.html(
			billFindingList(remaining, focus?.rawName ?? ""),
			200,
			headers,
		);
	}
	return c.redirect("/bills/find", 303);
});
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
		due_day: raw(raw("frequency") === "weekly" ? "weekly_day" : "due_day"),
		frequency: (
			["monthly", "yearly", "weekly", "biweekly", "quarterly"] as const
		).includes(raw("frequency") as Values["frequency"])
			? (raw("frequency") as Values["frequency"])
			: "monthly",
		anchor_month: raw("anchor_month"),
		anchor_date: raw("anchor_date"),
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
	const anchorDate = values.anchor_date;
	const validAnchorDate = validDateString(anchorDate);
	const due =
		values.frequency === "biweekly" && validAnchorDate
			? ((new Date(`${anchorDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1
			: Number(values.due_day);
	// A biweekly bill has no due day field: its weekday comes from its date, so only that date is checked.
	if (
		values.frequency !== "biweekly" &&
		(!Number.isInteger(due) ||
			due < 1 ||
			due > (values.frequency === "weekly" ? 7 : 31))
	)
		errors.due_day =
			values.frequency === "weekly"
				? "Choose a day of the week."
				: "Enter a day from 1 to 31.";
	if (values.frequency === "biweekly" && !validAnchorDate)
		errors.anchor_date = "Choose a date.";
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
		(values.frequency === "yearly" || values.frequency === "quarterly") &&
		(!Number.isInteger(anchor) || anchor < 1 || anchor > 12)
	)
		errors.anchor_month = "Choose a month.";
	const bill = id ? await dbBill(c, id) : undefined;
	if (id && !bill) return c.notFound();
	// Only a new name is checked: a bill that already shares its name can still be edited.
	if (!errors.name && !(bill && sameBillName(bill.name, values.name))) {
		const duplicate = duplicateBillName(await activeBills(c), values.name, id);
		if (duplicate) errors.name = alreadyCalled(duplicate);
	}
	// P45 A: a very large amount, added or edited, is saved only once its own "Yes, $X is right" chip
	// is ticked.
	let bigAmount: BigAmount | undefined;
	if (!errors.amount && cents > BIG_BILL_CENTS) {
		bigAmount = {
			cents,
			confirmed: !needsBigAmountConfirm(cents, raw("confirm_amount")),
		};
		if (!bigAmount.confirmed)
			errors.amount = `${formatCents(cents)} is a lot for a bill.`;
	}
	// Linked payments are budget history, so a bill that has them keeps its schedule. A weekly bill's
	// due day is its weekday, which names its occurrences, so moving it is a change of schedule too.
	const periodKeysChanged =
		!!bill &&
		(bill.frequency !== values.frequency ||
			bill.anchor_month !==
				(values.frequency === "yearly" || values.frequency === "quarterly"
					? anchor
					: null) ||
			bill.anchor_date !==
				(values.frequency === "biweekly" ? anchorDate : null) ||
			(values.frequency === "weekly" && bill.due_day !== due));
	const protectedScheduleChanged = periodKeysChanged;
	if (protectedScheduleChanged) {
		const linked = await c.env.DB.prepare(
			"SELECT 1 FROM bill_payments WHERE bill_id=? AND status='linked' LIMIT 1",
		)
			.bind(id)
			.first();
		if (linked) {
			// The message goes under the field that changed, so it is visible on the form.
			const field =
				bill.frequency !== values.frequency
					? "frequency"
					: values.frequency === "weekly"
						? "due_day"
						: values.frequency === "biweekly"
							? "anchor_date"
							: "anchor_month";
			errors[field] =
				bill.frequency === values.frequency
					? "This bill has payments linked. To change when it's due, deactivate it and add a new bill."
					: "This bill has payments linked. To change how often it's due, deactivate it and add a new bill.";
		}
	}
	if (Object.keys(errors).length)
		return page(c, { bill: bill ?? undefined, values, errors, bigAmount });
	// Typed bank text saves its transaction's merchant key, so the bill's payments match it (spec §6.1). Only a
	// text the bill already has keeps the bill's old bank-text flag, so an unchanged legacy bill keeps matching
	// by bank text (write.ts).
	const merchantRawName =
		bill?.merchant_raw_name === values.merchant_raw_name
			? values.merchant_raw_name
			: await merchantKeyOfBankText(c.env.DB, values.merchant_raw_name);
	const fields: BillFields = {
		name: values.name,
		amountCents: cents,
		dueDay: due,
		frequency: values.frequency,
		anchorMonth:
			values.frequency === "yearly" || values.frequency === "quarterly"
				? anchor
				: null,
		anchorDate: values.frequency === "biweekly" ? anchorDate : null,
		categoryId: Number(values.category_id),
		merchantRawName,
		typedMerchantText: values.merchant_raw_name,
	};
	// Old dismissals have no meaning once the schedule changes (links can't exist here, checked above).
	// The household's date is read once, here, and its month is what a changed amount applies from.
	const today = await householdToday(c.env.DB);
	const month = today.slice(0, 7);
	const written = id
		? await updateBill(c.env.DB, id, fields, periodKeysChanged, month)
		: await insertBill(c.env.DB, fields, today);
	// Another save took the name since the check above, and the write refused it.
	if (!written)
		return nameTaken(c, { bill: bill ?? undefined, values, bigAmount });
	await matchBillPayments(c.env.DB, today);
	const message = id ? "Bill saved" : "Bill added";
	if (c.req.header("HX-Request")) {
		const res = await page(c, undefined, today);
		res.headers.set(
			"HX-Trigger",
			JSON.stringify({
				toast: { message, type: "success" },
				announce: message,
			}),
		);
		res.headers.set("HX-Push-Url", "/bills");
		return res;
	}
	return c.redirect("/bills", 303);
}
bills.post("/bills", (c) => save(c));
bills.post("/bills/:id", (c) => save(c, Number(c.req.param("id"))));
/** What a person gets after a bill is switched on or off: Bills again, with the toast. */
async function activeChanged(c: Context<App>, message: string) {
	if (!c.req.header("HX-Request")) return c.redirect("/bills", 303);
	const res = await page(c);
	res.headers.set(
		"HX-Trigger",
		JSON.stringify({
			toast: { message, type: "success" },
			announce: message,
		}),
	);
	res.headers.set("HX-Push-Url", "/bills");
	return res;
}
bills.post("/bills/:id/deactivate", async (c) => {
	const { meta } = await c.env.DB.prepare(
		"UPDATE bills SET active=0 WHERE id=?",
	)
		.bind(Number(c.req.param("id")))
		.run();
	if (!meta.changes) return c.notFound();
	return activeChanged(c, "Bill deactivated");
});
bills.post("/bills/:id/reactivate", async (c) => {
	const id = Number(c.req.param("id"));
	const bill = await dbBill(c, id);
	if (!bill) return c.notFound();
	// After a refusal the sheet's Reactivate sends ?rename=1: the Name field is then the way out, so
	// what it holds is the name the bill comes back under. Otherwise the bill keeps its own name.
	const name =
		c.req.query("rename") === "1"
			? String((await c.req.parseBody()).name ?? "").trim()
			: bill.name;
	const values = { ...valuesOf(bill), name };
	if (!name)
		return page(c, { bill, values, errors: { name: "Enter a name." } });
	// A bill that would repeat an active bill's name comes back as the same Name error as adding.
	if (!bill.active && !(await activateBill(c.env.DB, id, name)))
		return nameTaken(c, { bill, values });
	// A payment that arrived while the bill was off links now, as a save does (spec §6.1).
	await matchBillPayments(c.env.DB);
	return activeChanged(c, "Bill reactivated");
});

type LinkedPayment = {
	period: string;
	transaction_id: number;
	matched_by: "auto" | "user";
	date: string;
	amount_cents: number;
	raw_name: string;
	display_name: string | null;
	excluded?: number;
};
const monthName = (period: string, today: string) =>
	new Intl.DateTimeFormat("en-US", {
		month: "long",
		...(period.slice(0, 4) === today.slice(0, 4)
			? {}
			: { year: "numeric" as const }),
		timeZone: "UTC",
	}).format(new Date(`${period}-01T00:00:00Z`));
const shortDate = (date: string) =>
	new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));

/** The first date after `today` in the every-two-weeks series from `anchor` (anchor + 14k). */
function nextTwoWeeksAfter(anchor: string, today: string): string {
	const dayNumber = (date: string) =>
		Date.parse(`${date}T00:00:00Z`) / 86_400_000;
	const steps = Math.max(
		0,
		Math.floor((dayNumber(today) - dayNumber(anchor)) / 14) + 1,
	);
	return new Date((dayNumber(anchor) + 14 * steps) * 86_400_000)
		.toISOString()
		.slice(0, 10);
}

const occurrenceLabel = (date: string) =>
	new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${date}T00:00:00Z`));
const addMonths = (period: string, amount: number) => {
	const date = new Date(`${period}-01T00:00:00Z`);
	date.setUTCMonth(date.getUTCMonth() + amount);
	return date.toISOString().slice(0, 7);
};
const occurrenceDate = (bill: DbBill, period: string) => {
	if (bill.frequency === "weekly" || bill.frequency === "biweekly")
		return period;
	if (bill.frequency === "quarterly") {
		const quarter = Number(period.slice(-1));
		const firstQuarter = Math.floor(((bill.anchor_month ?? 1) - 1) / 3) + 1;
		const month =
			(((bill.anchor_month ?? 1) - 1 + ((quarter - firstQuarter + 4) % 4) * 3) %
				12) +
			1;
		return billOccurrenceForMonth(
			{
				frequency: bill.frequency,
				dueDay: bill.due_day,
				anchorMonth: bill.anchor_month,
			},
			Number(period.slice(0, 4)),
			month,
		).dueDate;
	}
	const month =
		bill.frequency === "monthly"
			? period
			: `${period}-${String(bill.anchor_month).padStart(2, "0")}`;
	return billOccurrenceForMonth(
		{
			frequency: bill.frequency,
			dueDay: bill.due_day,
			anchorMonth: bill.anchor_month,
			anchorDate: bill.anchor_date,
		},
		Number(month.slice(0, 4)),
		Number(month.slice(5, 7)),
	).dueDate;
};
const occurrenceMonth = (bill: DbBill, period: string) =>
	occurrenceDate(bill, period).slice(0, 7);
/** The bill as the counting rule reads it, so the month a payment counts in is worked out one way (src/db/counted-month.ts). */
const countedBill = (bill: DbBill): CountedBill => ({
	frequency: bill.frequency,
	anchorMonth: bill.anchor_month,
});
/**
 * A period in words, as the picker's month choices and the link messages name it: the month a monthly or yearly
 * bill's period is for, else the occurrence's due date (#205, decision 101).
 */
const periodLabel = (bill: DbBill, period: string, today: string) =>
	["monthly", "yearly"].includes(bill.frequency)
		? monthName(billPeriodMonth(countedBill(bill), period), today)
		: occurrenceLabel(occurrenceDate(bill, period));
/**
 * The periods that are Paid (decision 101): those whose linked cents, `paidByPeriod`, reach 90% of the amount of
 * their own month (occurrencePaid, src/bills/amount.ts). A period with a part payment is left out.
 */
function paidPeriodsOf(
	bill: DbBill,
	history: AmountRow[],
	paidByPeriod: ReadonlyMap<string, number>,
) {
	return new Set(
		[...paidByPeriod]
			.filter(([period, cents]) =>
				occurrencePaid(
					cents,
					amountForMonth(
						history,
						billPeriodMonth(countedBill(bill), period),
						bill.amount_cents,
					),
				),
			)
			.map(([period]) => period),
	);
}
/** The shape of each frequency's payment keys (bill_payments.period), so a key of another shape never sets a start. */
const periodKeyShape: Record<DbBill["frequency"], RegExp> = {
	monthly: /^\d{4}-\d{2}$/,
	yearly: /^\d{4}$/,
	weekly: /^\d{4}-\d{2}-\d{2}$/,
	biweekly: /^\d{4}-\d{2}-\d{2}$/,
	quarterly: /^\d{4}-Q[1-4]$/,
};
/** The periods a bill's page lists and accepts: back to its earliest linked payment (or six months), ahead two months (a year for yearly bills). */
async function billPeriods(db: D1Database, bill: DbBill, today: string) {
	const linked = await db
		.prepare(
			"SELECT period FROM bill_payments WHERE bill_id=? AND status='linked'",
		)
		.bind(bill.id)
		.all<{ period: string }>();
	let start = addMonths(today.slice(0, 7), -6);
	for (const { period } of linked.results) {
		if (!periodKeyShape[bill.frequency].test(period)) continue;
		const month = occurrenceMonth(bill, period);
		if (month < start) start = month;
	}
	const end = addMonths(
		today.slice(0, 7),
		bill.frequency === "yearly" ? 12 : 2,
	);
	const result = new Set<string>();
	for (let month = start; month <= end; month = addMonths(month, 1)) {
		for (const occurrence of billOccurrencesForMonth(
			{
				frequency: bill.frequency,
				dueDay: bill.due_day,
				anchorMonth: bill.anchor_month,
				anchorDate: bill.anchor_date,
			},
			Number(month.slice(0, 4)),
			Number(month.slice(5, 7)),
		))
			result.add(occurrence.period);
	}
	// The picker and the link routes keep every period, handled ones included (decision 99); only the Payments list leaves them out.
	result.add(
		billOccurrence(
			{
				frequency: bill.frequency,
				dueDay: bill.due_day,
				anchorMonth: bill.anchor_month,
				anchorDate: bill.anchor_date,
			},
			today,
			new Set(),
		).period,
	);
	return [...result].sort((a, b) =>
		occurrenceDate(bill, b).localeCompare(occurrenceDate(bill, a)),
	);
}

async function billPage(
	c: Context<App>,
	id: number,
	requestedPeriod?: string,
	error?: string,
	selectedTransactionId?: number,
	given?: string,
	rerender = false,
	// The occurrence whose Not this one takes focus, when an Undo has just linked it again (#340).
	focusTransactionId?: number,
) {
	const bill = await dbBill(c, id);
	if (!bill) return c.notFound();
	const today = given ?? (await householdToday(c.env.DB));
	const periods = await billPeriods(c.env.DB, bill, today);
	if (requestedPeriod && !periods.includes(requestedPeriod))
		return c.notFound();
	const payments = (
		await c.env.DB.prepare(
			`SELECT bp.period,bp.transaction_id,bp.matched_by,t.date,t.amount_cents,t.raw_name,COALESCE(${ownNameSql("t")}, ${merchantColumnSql("t", "display_name")}) AS display_name FROM bill_payments bp JOIN transactions t ON t.id=bp.transaction_id WHERE bp.bill_id=? AND bp.status='linked' AND bp.period IN (SELECT value FROM json_each(?)) ORDER BY t.date,bp.id`,
		)
			.bind(id, JSON.stringify(periods))
			.all<LinkedPayment>()
	).results;
	// A month can hold several payments (decision 101), so each period lists all of its own, in date order.
	const byPeriod = new Map<string, LinkedPayment[]>();
	for (const payment of payments)
		byPeriod.set(payment.period, [
			...(byPeriod.get(payment.period) ?? []),
			payment,
		]);
	// An unpaid occurrence due before the day the bill was added is already handled, so it has no row (decision 99).
	// The picker still lists every period, so a payment can be linked to one by hand.
	const listedPeriods = periods.filter(
		(period) =>
			!handledBeforeAdded(
				bill.added_on,
				occurrenceDate(bill, period),
				byPeriod.has(period),
			),
	);
	// Each occurrence is judged at its own month's amount (decision 101), so the page, the picker and the
	// price offer all read the same figure for one occurrence.
	const history = (await amountRowsByBill(c.env.DB, id)).get(id) ?? [];
	const amountOn = (dueDate: string) =>
		amountForMonth(history, dueDate.slice(0, 7), bill.amount_cents);
	const paidOf = (period: string) =>
		(byPeriod.get(period) ?? []).reduce(
			(total, payment) => total + payment.amount_cents,
			0,
		);
	// Paid once its payments reach 90% of its amount (decision 101); a part-paid period isn't in this set.
	const paidPeriods = paidPeriodsOf(
		bill,
		history,
		new Map([...byPeriod.keys()].map((period) => [period, paidOf(period)])),
	);
	// A Paid month takes no more payments (decision 101): its picker is never built, and the page says it is paid
	// (#205). The opened period is then always one of the picker's months, so the picker needs no check of its own.
	const paidPicker =
		requestedPeriod && paidPeriods.has(requestedPeriod)
			? requestedPeriod
			: undefined;
	const pickerPeriod = paidPicker ? undefined : requestedPeriod;
	const refusal = paidPicker
		? `${periodLabel(bill, paidPicker, today)}'s bill is already paid.`
		: undefined;
	const shownError = error ?? refusal;
	const pickerAmount = pickerPeriod
		? amountOn(occurrenceDate(bill, pickerPeriod))
		: bill.amount_cents;
	// The picker sorts by closeness to what's still unpaid in the month (decision 79), not to its whole amount.
	const pickerLeftCents = pickerPeriod
		? Math.max(0, pickerAmount - paidOf(pickerPeriod))
		: pickerAmount;
	let candidates: (LinkedPayment & {
		sameMerchant: number;
		turnedAway: number;
	})[] = [];
	if (pickerPeriod) {
		const due = occurrenceDate(bill, pickerPeriod);
		// A payment the person turned away for this month stays listed, last, under "You said not this one" (#340).
		candidates = (
			await c.env.DB.prepare(
				`SELECT t.id AS transaction_id,t.date,t.amount_cents,t.raw_name,COALESCE(${ownNameSql("t")}, ${merchantColumnSql("t", "display_name")}) AS display_name,t.excluded,CASE WHEN ${isMerchantTextSql("t")} THEN 1 ELSE 0 END AS sameMerchant,EXISTS(SELECT 1 FROM bill_payments dismissed WHERE dismissed.bill_id=? AND dismissed.period=? AND dismissed.transaction_id=t.id AND dismissed.status='dismissed' AND dismissed.matched_by='user') AS turnedAway FROM transactions t WHERE abs(julianday(t.date)-julianday(?))<=? AND t.is_split=0 AND t.flag_income=0 AND t.amount_cents>0 AND NOT EXISTS(SELECT 1 FROM bill_payments bp WHERE bp.transaction_id=t.id AND bp.status='linked') ORDER BY turnedAway, sameMerchant DESC, abs(t.amount_cents-?), abs(julianday(t.date)-julianday(?)), t.id`,
			)
				.bind(
					...merchantTextArgs(bill),
					bill.id,
					pickerPeriod,
					due,
					manualLinkWindowDays(bill.frequency),
					pickerLeftCents,
					due,
				)
				.all<LinkedPayment & { sameMerchant: number; turnedAway: number }>()
		).results;
	}
	const current = billOccurrence(
		{
			frequency: bill.frequency,
			dueDay: bill.due_day,
			anchorMonth: bill.anchor_month,
			anchorDate: bill.anchor_date,
			addedOn: bill.added_on,
		},
		today,
		paidPeriods,
		new Set(byPeriod.keys()),
	);
	// A payment at another price, offered on the occurrence the Bills row shows (P36 B, spec §8.5).
	const currentCents = amountOn(current.dueDate);
	const offer = await findPriceOffer(
		c.env.DB,
		offerBill(bill, current, currentCents, paidOf(current.period)),
	);
	const change = latestPriceChange(history);
	const picker = pickerPeriod ? (
		<BillPaymentPicker
			billId={id}
			billName={bill.name}
			billAmountCents={pickerAmount}
			openedPeriod={pickerPeriod}
			dueDateLabel={shortDate(occurrenceDate(bill, pickerPeriod))}
			bill={countedBill(bill)}
			selectedTransactionId={selectedTransactionId}
			rerender={rerender}
			candidates={candidates.map((t) => ({
				id: t.transaction_id,
				displayName: t.display_name ?? tidyName(t.raw_name),
				date: t.date,
				dateLabel: shortDate(t.date),
				amountCents: t.amount_cents,
				excluded: t.excluded === 1,
				turnedAway: t.turnedAway === 1,
			}))}
			periods={periods
				// A part-paid month stays on the list, so another payment can be linked to it (decision 101).
				.filter((period) => !paidPeriods.has(period))
				.map((period) => ({
					value: period,
					label: periodLabel(bill, period, today),
				}))}
		/>
	) : null;
	if (picker && rerender) {
		// The picker arrives whole, so a live line inside it isn't reliably spoken; the count goes to the announcer instead.
		c.header(
			"HX-Trigger",
			JSON.stringify({ announce: paymentCountSentence(candidates.length) }),
		);
		return c.html(picker);
	}
	if (paidPicker && rerender) {
		// A month chip asked for a Paid month: its reply is the whole page, which replaces the body (as transactions.tsx's
		// swapWholePage does), since the chip's own target, the picker, is gone.
		c.header("HX-Retarget", "body");
		c.header("HX-Reswap", "outerHTML");
	}
	return c.html(
		<Layout
			title={`${bill.name} · Tally`}
			active="bills"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path}
		>
			{/* #page is what an Undo toast swaps in (toast.js), as on the Transactions page. */}
			<div id="page" class="max-w-2xl">
				<a href="/bills" class="inline-flex min-h-11 items-center">
					Bills
				</a>
				<p class="text-sm text-muted">{bill.merchant_raw_name}</p>
				<h1
					id="page-title"
					class="font-serif text-5xl font-semibold tracking-tight"
				>
					{bill.name}
				</h1>
				<p class="text-lg">
					{formatCents(bill.amount_cents)}{" "}
					{bill.frequency === "weekly"
						? `every ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][bill.due_day - 1]}`
						: bill.frequency === "biweekly"
							? "every two weeks"
							: bill.frequency === "quarterly"
								? "every 3 months"
								: `${bill.frequency === "monthly" ? "a month" : "a year"}, due the ${ordinal(bill.due_day)}`}
				</p>
				{change && (
					<PriceChangeLine
						direction={change.direction}
						amountCents={change.amountCents}
						month={monthLabel(change.effectiveMonth, today)}
					/>
				)}
				{shownError && (
					<p role="alert" class="mt-3 text-over">
						{shownError}
					</p>
				)}
				<h2 class="mt-6 text-sm text-muted">Payments</h2>
				<ul class="divide-y divide-rule border-y border-rule">
					{listedPeriods.map((period) => {
						const linkedPayments = byPeriod.get(period) ?? [];
						const due = occurrenceDate(bill, period);
						// A missed weekly Friday from this month is overdue and set aside (Bills' totals count it so);
						// only one from an earlier month reads Not paid, part paid or not.
						const missedThisMonth =
							["weekly", "biweekly"].includes(bill.frequency) &&
							due.slice(0, 7) === today.slice(0, 7);
						const status = paidPeriods.has(period)
							? "paid"
							: period === current.period
								? current.status
								: due < today
									? missedThisMonth
										? "overdue"
										: "not-paid"
									: "upcoming";
						return (
							<BillOccurrenceRow
								billId={id}
								period={period}
								focusTransactionId={focusTransactionId}
								label={`${
									["monthly", "yearly"].includes(bill.frequency)
										? monthName(
												billPeriodMonth(countedBill(bill), period),
												today,
											)
										: occurrenceLabel(due)
								} · ${formatCents(amountOn(due))}`}
								status={status}
								paidCents={paidOf(period)}
								amountCents={amountOn(due)}
								payments={linkedPayments.map((payment) => ({
									transactionId: payment.transaction_id,
									displayName:
										payment.display_name ?? tidyName(payment.raw_name),
									dateLabel: shortDate(payment.date),
									amountCents: payment.amount_cents,
									matchedBy: payment.matched_by,
								}))}
								priceOffer={
									offer && period === current.period
										? {
												transactionId: offer.transactionId,
												merchant: offer.merchant,
												amountCents: offer.amountCents,
												dateLabel: shortDay(offer.date, today),
												billAmountCents: currentCents,
												currentCents: bill.amount_cents,
												frequency: bill.frequency,
												cadence: billCadenceLabel({
													frequency: bill.frequency,
													dueDay: bill.due_day,
												}),
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
					{bill.active && (
						<form
							method="post"
							action={`/bills/${id}/deactivate`}
							hx-post={`/bills/${id}/deactivate`}
							hx-target="body"
							hx-swap="outerHTML"
							class="inline"
						>
							<Button kind="text" type="submit">
								Deactivate
							</Button>
						</form>
					)}
				</div>
				<p class="mt-6 border-t border-rule pt-3 text-sm text-muted">
					&quot;Not this one&quot; unlinks a payment, and Tally won't suggest it
					again for that month.
				</p>
				{picker}
				<div id="sheet" />
			</div>
		</Layout>,
	);
}

bills.get("/bills/:id/occurrences/:period/link", (c) =>
	billPage(
		c,
		Number(c.req.param("id")),
		c.req.param("period"),
		undefined,
		Number(c.req.query("transaction_id")) || undefined,
		undefined,
		// htmx sends HX-Request on every request it makes, and only a month chip asks for this URL that way:
		// it gets the picker back to swap in place, never a second page.
		Boolean(c.req.header("HX-Request")),
	),
);
bills.get("/bills/:id/month-explanation", async (c) => {
	const id = Number(c.req.param("id"));
	const period = c.req.query("period") ?? "";
	const transactionId = Number(c.req.query("transaction_id"));
	const bill = await dbBill(c, id);
	if (
		!bill ||
		!(
			await billPeriods(c.env.DB, bill, await householdToday(c.env.DB))
		).includes(period)
	)
		return c.notFound();
	if (!Number.isInteger(transactionId))
		return c.html(
			<p class="text-sm text-muted">
				A late payment counts in its bill's month; an early one stays in the
				month it was paid.
			</p>,
		);
	const payment = await c.env.DB.prepare(
		"SELECT date FROM transactions WHERE id=?",
	)
		.bind(transactionId)
		.first<{ date: string }>();
	if (!payment) return c.notFound();
	return c.html(
		<BillMonthExplanation
			bill={countedBill(bill)}
			period={period}
			paymentDate={payment.date}
		/>,
	);
});
bills.post("/bills/:id/link", async (c) => {
	const id = Number(c.req.param("id"));
	const form = await c.req.parseBody();
	const transaction = Number(form.transaction_id);
	const period = String(form.period ?? "");
	const opened = String(form.opened_period ?? period);
	const bill = await dbBill(c, id);
	if (!bill) return c.notFound();
	const today = await householdToday(c.env.DB);
	if (
		!(Number.isInteger(transaction) && transaction > 0) ||
		!(await billPeriods(c.env.DB, bill, today)).includes(period)
	)
		return billPage(
			c,
			id,
			opened,
			"Choose a payment and month.",
			undefined,
			today,
		);
	const due = occurrenceDate(bill, period);
	const manualWindow = manualLinkWindowDays(bill.frequency);
	const label = periodLabel(bill, period, today);
	// A Paid month takes no more payments (decision 101): the picker lists none for it, so a request that names one is refused.
	const paidCents =
		(
			await c.env.DB.prepare(
				"SELECT COALESCE(SUM(t.amount_cents), 0) AS cents FROM bill_payments bp JOIN transactions t ON t.id=bp.transaction_id WHERE bp.bill_id=? AND bp.period=? AND bp.status='linked'",
			)
				.bind(id, period)
				.first<{ cents: number }>()
		)?.cents ?? 0;
	const history = (await amountRowsByBill(c.env.DB, id)).get(id) ?? [];
	if (paidPeriodsOf(bill, history, new Map([[period, paidCents]])).has(period))
		return billPage(
			c,
			id,
			opened,
			`${label}'s bill is already paid.`,
			undefined,
			today,
		);
	// Only money out pays a bill: a positive amount is money out, in Plaid's sign (#324). A credit fails here
	// and in the INSERT below, with the same message as a payment outside the window.
	const eligible = await c.env.DB.prepare(
		"SELECT 1 FROM transactions WHERE id=? AND is_split=0 AND flag_income=0 AND amount_cents>0 AND abs(julianday(date)-julianday(?))<=?",
	)
		.bind(transaction, due, manualWindow)
		.first();
	if (!eligible) {
		return billPage(
			c,
			id,
			opened,
			`That payment isn't within ${manualWindow} days of ${label}'s bill.`,
			undefined,
			today,
		);
	}
	// An excluded payment can pay a bill: once linked it counts in Spent whatever its exclusion, which
	// linking never writes (spec §6.1 rule 4, §8.5).
	// The Not this one a link replaces (decision 99, and decision 105 for a purchase's) is lifted by liftNotThisOneSql, once
	// the link is in. It runs only when this link was made, since the DELETE needs the linked row this payment just got.
	const [insert] = await c.env.DB.batch([
		c.env.DB.prepare(
			`INSERT OR IGNORE INTO bill_payments(bill_id,period,transaction_id,matched_by,status) SELECT ?,?,?,'user','linked' WHERE EXISTS(SELECT 1 FROM transactions WHERE id=? AND is_split=0 AND flag_income=0 AND amount_cents>0 AND abs(julianday(date)-julianday(?))<=?)`,
		).bind(id, period, transaction, transaction, due, manualWindow),
		c.env.DB.prepare(liftNotThisOneSql).bind(id, period, transaction),
	]);
	if (!insert?.meta.changes)
		return billPage(
			c,
			id,
			opened,
			"That payment is already linked.",
			undefined,
			today,
		);
	return feedbackRedirect(c, id, "Payment linked", today);
});
bills.post("/bills/:id/occurrences/:period/unlink", async (c) => {
	const id = Number(c.req.param("id"));
	const period = c.req.param("period");
	// A month can hold several payments (decision 101), so the one a Not this one names is unlinked, and only it. One
	// that names none (a page from before this change) unlinks the month's only payment, and is refused when there are more.
	const form = await c.req.parseBody();
	const named =
		form.transaction_id === undefined ? undefined : Number(form.transaction_id);
	const paid = (
		await c.env.DB.prepare(
			"SELECT transaction_id FROM bill_payments WHERE bill_id=? AND period=? AND status='linked'",
		)
			.bind(id, period)
			.all<{ transaction_id: number }>()
	).results;
	const linked =
		named === undefined
			? paid.length === 1
				? paid[0]
				: undefined
			: paid.find((row) => row.transaction_id === named);
	if (!linked) return c.notFound();
	// The token is random and saved on this Not this one, so its Undo works once (#340). It keeps the payment's id,
	// so a Not this one that later moves to another payment is refused, as before.
	const undoToken = `${linked.transaction_id}.${crypto.randomUUID()}`;
	await c.env.DB.batch([
		c.env.DB.prepare(
			"DELETE FROM bill_payments WHERE bill_id=? AND period=? AND transaction_id=? AND status='linked'",
		).bind(id, period, linked.transaction_id),
		c.env.DB.prepare(
			"INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status,undo_token) VALUES(?,?,?,'user','dismissed',?)",
		).bind(id, period, linked.transaction_id, undoToken),
	]);
	const undo = await unlinkUndo(c.env.DB, undoToken);
	return feedbackRedirect(
		c,
		id,
		"Payment unlinked",
		undefined,
		"Payment unlinked. Undo for 10 seconds.",
		{
			undo: undo.token,
			undoExpiresInMs: undo.ms,
			undoAction: `/bills/${id}/undo-unlink`,
		},
	);
});
/**
 * The Undo for a Not this one (#340): its token, and the rest of its ten seconds, counted by the database's clock as
 * its created_at was. The row is found by its undo_token, which is random, so a later Not this one never matches it.
 */
async function unlinkUndo(db: D1Database, token: string) {
	const row = await db
		.prepare(
			"SELECT CAST(MAX(0, MIN(10000, (julianday(created_at) + 10.0 / 86400 - julianday('now')) * 86400000)) AS INTEGER) AS ms FROM bill_payments WHERE undo_token=?",
		)
		.bind(token)
		.first<{ ms: number }>();
	return { token, ms: row?.ms ?? 0 };
}
/**
 * Undo for a Not this one (#340): relinks the payment to its month and lifts the dismissal. The token works once and
 * only within ten seconds of the dismissal, by the database's clock (see unlinkUndo for its parts).
 */
bills.post("/bills/:id/undo-unlink", async (c) => {
	const id = Number(c.req.param("id"));
	const form = await c.req.parseBody();
	const token = String(form.token ?? "");
	// The token's payment, when it has the right shape: its transaction id, a dot and the random UUID saved on the Not this one.
	const [, transactionId] = /^(\d+)\.([0-9a-f-]{36})$/i.exec(token) ?? [];
	// The Not this one the token names, if it is still there, and whether its ten seconds are still running.
	const held = transactionId
		? await c.env.DB.prepare(
				"SELECT transaction_id AS transactionId, period, julianday('now')-julianday(created_at)<10.0/86400 AS fresh FROM bill_payments WHERE undo_token=? AND transaction_id=? AND bill_id=? AND status='dismissed' AND matched_by='user'",
			)
				.bind(token, Number(transactionId), id)
				.first<{ transactionId: number; period: string; fresh: number }>()
		: null;
	// The link comes back as the matcher's ('auto'): the dismissal doesn't remember how the payment was linked, and most
	// links are the matcher's. Only a hand link's "by hand" label is lost (the export keeps the column). The guard checks
	// the token again, since the read above and this batch don't run atomically.
	const restored = held?.fresh
		? (
				await c.env.DB.batch([
					c.env.DB.prepare(
						`INSERT INTO bill_payments(bill_id,period,transaction_id,matched_by,status)
						 SELECT ?1,?2,?3,'auto','linked' WHERE EXISTS(SELECT 1 FROM bill_payments WHERE undo_token=?4 AND transaction_id=?3 AND status='dismissed' AND matched_by='user' AND julianday('now')-julianday(created_at)<10.0/86400)
						 AND NOT EXISTS(SELECT 1 FROM bill_payments WHERE transaction_id=?3 AND status='linked')
						 AND EXISTS(SELECT 1 FROM transactions WHERE id=?3 AND is_split=0 AND flag_income=0 AND amount_cents>0)`,
					).bind(id, held.period, held.transactionId, token),
					c.env.DB.prepare(liftNotThisOneSql).bind(
						id,
						held.period,
						held.transactionId,
					),
				])
			)[0]?.meta.changes === 1
		: false;
	if (!c.req.header("HX-Request")) return c.redirect(`/bills/${id}`, 303);
	const response = await billPage(
		c,
		id,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		restored ? held?.transactionId : undefined,
	);
	// The Undo may come from an open Edit sheet, whose /edit address the bar still shows: the bill's own address replaces it.
	response.headers.set("HX-Push-Url", `/bills/${id}`);
	// Each outcome claims only what is true of the payment: the link is back, or it stays unlinked. A month can hold
	// other payments now (decision 101), so a restored payment never waits on them. Every answer ends this Undo's
	// toast, so undoDone names its token on each one (#340, #397).
	let toast: { message: string; type: "success" | "error"; undoDone?: string };
	if (restored)
		toast = {
			message: "Payment linked again",
			type: "success",
			undoDone: token,
		};
	else if (!held)
		toast = { message: "Undo expired.", type: "error", undoDone: token };
	else if (!held.fresh)
		toast = {
			message: "Undo expired. The payment stays unlinked.",
			type: "error",
			undoDone: token,
		};
	else
		toast = {
			message: "Couldn't undo. The payment stays unlinked.",
			type: "error",
			undoDone: token,
		};
	response.headers.set(
		"HX-Trigger",
		JSON.stringify({ toast, announce: toast.message }),
	);
	return response;
});
async function feedbackRedirect(
	c: Context<App>,
	id: number,
	message: string,
	today?: string,
	announce = message,
	// Extra toast keys, such as an Undo's (see toast.js).
	toast: Record<string, unknown> = {},
) {
	if (c.req.header("HX-Request")) {
		const response = await billPage(
			c,
			id,
			undefined,
			undefined,
			undefined,
			today,
		);
		response.headers.set(
			"HX-Trigger",
			JSON.stringify({
				toast: { message, type: "success", ...toast },
				announce,
			}),
		);
		return response;
	}
	return c.redirect(`/bills/${id}`, 303);
}

/**
 * The occurrence a bill's Bills row and page ask about, and the question: what `findPriceOffer` finds for it.
 * `amountCents` is that occurrence's own amount (decision 101), not the bill's current one.
 */
function offerBill(
	bill: DbBill,
	occurrence: { period: string; dueDate: string; status: BillStatus },
	amountCents: number,
	paidCents: number,
) {
	return {
		id: bill.id,
		active: !!bill.active,
		status: occurrence.status,
		frequency: bill.frequency,
		amountCents,
		merchantRawName: bill.merchant_raw_name,
		merchantRawText: bill.merchant_raw_text,
		period: occurrence.period,
		dueDate: occurrence.dueDate,
		paidCents,
	};
}
async function currentOffer(
	c: Context<App>,
	bill: DbBill,
	today: string,
): Promise<
	| ({ period: string; dueMonth: string; billCents: number } & PriceOffer)
	| undefined
> {
	const linked = (
		await c.env.DB.prepare(
			"SELECT bp.period AS period, t.amount_cents AS cents FROM bill_payments bp JOIN transactions t ON t.id=bp.transaction_id WHERE bp.bill_id=? AND bp.status='linked'",
		)
			.bind(bill.id)
			.all<{ period: string; cents: number }>()
	).results;
	const paidByPeriod = new Map<string, number>();
	for (const row of linked)
		paidByPeriod.set(
			row.period,
			(paidByPeriod.get(row.period) ?? 0) + row.cents,
		);
	const history =
		(await amountRowsByBill(c.env.DB, bill.id)).get(bill.id) ?? [];
	const current = billOccurrence(
		{
			frequency: bill.frequency,
			dueDay: bill.due_day,
			anchorMonth: bill.anchor_month,
			anchorDate: bill.anchor_date,
			addedOn: bill.added_on,
		},
		today,
		paidPeriodsOf(bill, history, paidByPeriod),
		new Set(paidByPeriod.keys()),
	);
	const billCents = amountForMonth(
		history,
		current.dueDate.slice(0, 7),
		bill.amount_cents,
	);
	const offer = await findPriceOffer(
		c.env.DB,
		offerBill(bill, current, billCents, paidByPeriod.get(current.period) ?? 0),
	);
	return (
		offer && {
			period: current.period,
			dueMonth: current.dueDate.slice(0, 7),
			billCents,
			...offer,
		}
	);
}

// "Price changed?" (P36 B, decision 72): a payment from the bill's merchant at another price is offered
// on the bill's page. Yes links it and sets the bill's amount to what was charged; "Not this bill"
// remembers the payment for that month. Both answer for the very payment the page showed, and Yes also
// for the prices it showed, in whole cents: the occurrence's amount, the charge, and the bill's current
// amount. Once any of them has changed, a page that has gone stale saves nothing and the person is told,
// so no one is made to accept a price they didn't see.
const wholeCents = (value: unknown) =>
	typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
async function answerPrice(c: Context<App>, verb: "accept" | "dismiss") {
	const id = Number(c.req.param("id"));
	const period = c.req.param("period");
	const form = await c.req.parseBody();
	const transaction = Number(form.transaction_id);
	const bill = await dbBill(c, id);
	if (!bill) return c.notFound();
	const today = await householdToday(c.env.DB);
	const offer = await currentOffer(c, bill, today);
	const gone = () =>
		billPage(
			c,
			id,
			undefined,
			"That price change isn't on offer any more.",
			undefined,
			today,
		);
	if (!offer || offer.period !== period || offer.transactionId !== transaction)
		return gone();
	if (verb === "accept") {
		// The prices the page showed: the occurrence's amount, the charge (decision 101) and the bill's current amount.
		const seenBill = wholeCents(form.bill_cents);
		const seenCurrent = wholeCents(form.current_cents);
		if (
			seenBill !== offer.billCents ||
			wholeCents(form.charge_cents) !== offer.amountCents ||
			seenCurrent !== bill.amount_cents ||
			!(await acceptPriceOffer(
				c.env.DB,
				id,
				period,
				offer,
				seenBill,
				offer.dueMonth,
				seenCurrent,
				today.slice(0, 7),
			))
		)
			return gone();
	} else {
		await dismissPriceOffer(c.env.DB, id, period, transaction);
		return feedbackRedirect(
			c,
			id,
			`Left the bill at ${formatCents(bill.amount_cents)}`,
			today,
			`Price change dismissed. The bill stays ${formatCents(bill.amount_cents)}.`,
		);
	}
	// The new price applies from this month on, so an unpaid payment at it in this month or a later one may
	// now match; earlier months keep the price they had (decision 101).
	await matchBillPayments(c.env.DB, today);
	const updated = `Bill updated to ${formatCents(offer.amountCents)}`;
	return feedbackRedirect(
		c,
		id,
		updated,
		today,
		`${updated} and the payment linked`,
	);
}
bills.post("/bills/:id/occurrences/:period/price/accept", (c) =>
	answerPrice(c, "accept"),
);
bills.post("/bills/:id/occurrences/:period/price/dismiss", (c) =>
	answerPrice(c, "dismiss"),
);
