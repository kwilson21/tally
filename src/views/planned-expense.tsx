import { monthName, shortDay } from "../dates";
import { formatCents } from "../money";
import { BottomSheet, sheetAttrs } from "./bottom-sheet";
import { Button } from "./button";
import { FoldedRow } from "./folded-row";
import { Icon, ROW_OPENS, RowArrow } from "./icons";
import { LedgerField } from "./ledger-field";
import { CLOSEST_PAYMENTS, PaymentRow } from "./payment-row";
import { TextInput } from "./text-input";
import { WhyLink } from "./why-link";

/** The longest name a planned expense can have: the sheet's field stops at it, and the save refuses more (plans.tsx). */
export const PLAN_NAME_MAX = 80;

export type PlannedRowData = {
	id: number;
	name: string;
	amountCents: number;
	/** The month it is set aside in, `YYYY-MM`. */
	month: string;
	/** The linked payment's date, once it is paid. */
	paidDate?: string | null;
};

/** The month a plan is set aside for: "for October" in its own month or an earlier one, "from December" later. */
export function plannedLine(plan: PlannedRowData, month: string) {
	return plan.month > month
		? `Set aside from ${monthName(plan.month)}`
		: `Set aside for ${monthName(plan.month)}`;
}

/**
 * One planned expense, shaped like a bill row: the tag icon, its name, a muted line and its amount. Unpaid, it says what
 * it is set aside for; paid, it says when its payment came (P103). It is a link to its sheet when `href` is given, and
 * opens that sheet over Bills in place (as Plan an expense does), with `href` as the way in without script. The link's
 * id is `plan-<id>`, where the sheet's close returns focus (`autofocus`, when Bills is drawn with that focus, #87).
 */
export function PlannedRow({
	plan,
	month,
	today,
	href,
	autofocus = false,
	attrs,
}: {
	plan: PlannedRowData;
	/** The household's current month, `YYYY-MM`. */
	month: string;
	today: string;
	href?: string;
	autofocus?: boolean;
	/** The link's attributes, in place of opening its sheet (`sheetAttrs`); the catalog passes none, so it links in place. */
	attrs?: Record<string, string>;
}) {
	const content = (
		<>
			<span class="shrink-0 text-ink">
				<Icon name="tag" class="size-7" />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{plan.name}</span>
				<span class="block truncate leading-6 text-muted">
					{plan.paidDate
						? `Paid ${shortDay(plan.paidDate, today)}`
						: plannedLine(plan, month)}
				</span>
			</span>
			<span class="shrink-0 text-lg">{formatCents(plan.amountCents)}</span>
		</>
	);
	const look = "flex min-h-16 items-center gap-4";
	return (
		<li>
			{href ? (
				<a
					id={`plan-${plan.id}`}
					href={href}
					class={`${look} text-ink no-underline ${ROW_OPENS}`}
					autofocus={autofocus}
					data-row=""
					{...(attrs ?? sheetAttrs(href))}
				>
					{content}
					<RowArrow />
				</a>
			) : (
				<span class={look}>{content}</span>
			)}
		</li>
	);
}

/**
 * The Planned group's heading: the tag icon and the word, the Why? link, and this month's total of the plans
 * still unpaid ("$180.00 this month", decision 101).
 */
export function PlannedHeading({ totalCents }: { totalCents?: number }) {
	return (
		<div class="flex items-center gap-2 text-sm text-muted">
			<h2 class="flex min-w-0 items-center gap-2">
				<span class="text-muted">
					<Icon name="tag" class="size-4" />
				</span>
				Planned
			</h2>
			<span aria-hidden="true">·</span>
			<WhyLink section="bills" topic="planned expenses" />
			{totalCents !== undefined && (
				<span class="ml-auto shrink-0">
					{formatCents(totalCents)} this month
				</span>
			)}
		</div>
	);
}

/**
 * The Band for a plan unpaid when its month ended: "Car registration wasn't paid", with Move to this month's short name and Drop,
 * and, when two or more plans wait, a dot for each. The first dot is the one being asked; the rest are the other plans (P105).
 */
export function PlanBand({
	planId,
	name,
	moveLabel,
	waiting,
}: {
	planId: number;
	name: string;
	/** "Move to Nov": the household's current month, short. */
	moveLabel: string;
	/** How many unpaid plans from earlier months wait, this one included. */
	waiting: number;
}) {
	const move = `/plans/${planId}/move`;
	const drop = `/plans/${planId}/drop`;
	return (
		<section class="mt-3 bg-band px-4 py-3" aria-labelledby="plan-band-title">
			<p class="text-lg" id="plan-band-title">
				{name} wasn't paid
			</p>
			<div class="mt-3 flex flex-wrap items-center gap-3">
				<form
					method="post"
					action={move}
					hx-post={move}
					hx-target="body"
					hx-swap="outerHTML"
				>
					<Button type="submit" busyLabel="Moving…">
						Move to {moveLabel}
					</Button>
				</form>
				<form
					method="post"
					action={drop}
					hx-post={drop}
					hx-target="body"
					hx-swap="outerHTML"
				>
					<Button kind="secondary" type="submit" busyLabel="Dropping…">
						Drop
					</Button>
				</form>
				{/* A dot says which of several plans is asked; one plan needs none, so no dot and no count (#602). */}
				{waiting > 1 && (
					<span class="ml-auto flex items-center gap-1.5">
						{Array.from({ length: waiting }, (_, i) => (
							<span
								aria-hidden="true"
								class={`size-2.5 rounded-full ${i === 0 ? "bg-ink" : "bg-muted/40"}`}
							/>
						))}
						<span class="sr-only">
							1 of {waiting} planned expenses that weren't paid
						</span>
					</span>
				)}
			</div>
		</section>
	);
}

/** A month the Month select offers, as its value (`YYYY-MM`) and its words ("October 2026"). */
export type PlanMonthOption = { value: string; label: string };

export type PlanValues = { name: string; amount: string; month: string };

/**
 * Plan an expense, or a plan's own sheet (P102): What it's for, the Amount as the big ledger field, the Month as a
 * native select, then Save, Delete and Cancel. A plan with a payment shows it with an Unlink; an unpaid one can link
 * one on its page. `deleteConfirm` redraws the sheet to ask "Delete Car registration, $180.00?" first.
 * `opener` is true when the sheet was opened from the plan's own page (Edit planned expense), so it closes back there;
 * otherwise a plan's sheet closes to its row on Bills, and Plan an expense to its button (#87).
 */
export function PlanSheet({
	plan,
	values,
	months,
	errors = {},
	paidBy,
	deleteConfirm = false,
	opener = false,
}: {
	/** The plan being edited; absent for Plan an expense. */
	plan?: PlannedRowData;
	values: PlanValues;
	months: PlanMonthOption[];
	errors?: Record<string, string>;
	/** The linked payment's line when the plan is paid: its name, date and amount. */
	paidBy?: { name: string; date: string; amountCents: number };
	deleteConfirm?: boolean;
	opener?: boolean;
}) {
	const title = plan ? plan.name : "Plan an expense";
	const action = plan ? `/plans/${plan.id}` : "/plans";
	const amountCents = plan?.amountCents;
	// Closing the sheet, by the backdrop or Cancel, returns focus to what opened it (#87).
	const closeHref = !plan
		? "/bills?focus=plan-expense"
		: opener
			? `/plans/${plan.id}?focus=edit-plan`
			: `/bills?focus=plan-${plan.id}`;
	// The sheet's own links carry the opener too, so the delete question closes to the same place.
	const via = opener ? "?opener=plan" : "";
	const openerField = opener && (
		<input type="hidden" name="opener" value="plan" />
	);
	return (
		<BottomSheet
			labelledBy="plan-sheet-title"
			closeHref={closeHref}
			still={deleteConfirm || Object.keys(errors).length > 0}
		>
			<h2
				id="plan-sheet-title"
				class="font-serif text-4xl font-semibold tracking-tight"
				tabindex={-1}
				autofocus
			>
				{deleteConfirm ? (
					`Delete ${title}, ${formatCents(amountCents ?? 0)}?`
				) : (
					<>
						{plan && <span class="sr-only">Edit planned expense: </span>}
						{title}
					</>
				)}
			</h2>
			{deleteConfirm ? (
				<div class="flex flex-wrap gap-3">
					<form
						method="post"
						action={`${action}/delete`}
						hx-post={`${action}/delete`}
						hx-target="body"
						hx-swap="outerHTML"
					>
						<Button
							kind="secondary"
							type="submit"
							class="border-over text-over"
						>
							Delete
						</Button>
					</form>
					<Button
						href={`${action}/edit${via}`}
						kind="text"
						{...sheetAttrs(`${action}/edit${via}`, false)}
					>
						Cancel
					</Button>
				</div>
			) : (
				<form
					method="post"
					action={action}
					hx-post={action}
					hx-target="body"
					hx-swap="outerHTML"
					class="flex flex-col gap-3"
				>
					{openerField}
					<TextInput
						id="plan-name"
						name="name"
						label="What it's for"
						value={values.name}
						error={errors.name}
						surface="paper"
						required
						maxlength={PLAN_NAME_MAX}
					/>
					<LedgerField
						big
						prefix="$"
						id="plan-amount"
						name="amount"
						label="Amount"
						value={values.amount}
						error={errors.amount}
						inputmode="decimal"
						required
					/>
					<label class="flex flex-col gap-1">
						<span>Month</span>
						<select
							id="plan-month"
							name="month"
							class="min-h-11 rounded-control border border-rule bg-paper px-3"
						>
							{months.map((option) => (
								<option
									value={option.value}
									selected={option.value === values.month}
								>
									{option.label}
								</option>
							))}
						</select>
					</label>
					{errors.month && (
						<p role="alert" class="text-over">
							{errors.month}
						</p>
					)}
					{paidBy && (
						<div class="flex items-center justify-between gap-3 border-t border-rule pt-3">
							<p class="min-w-0">
								<span class="block text-sm text-muted">Paid by</span>
								{paidBy.name} · {paidBy.date} ·{" "}
								{formatCents(paidBy.amountCents)}
							</p>
							<Button
								kind="secondary"
								type="submit"
								form="plan-unlink"
								class="shrink-0 px-4"
							>
								Unlink
								<span class="sr-only"> the {paidBy.name} payment</span>
							</Button>
						</div>
					)}
					<div class="flex flex-wrap items-center gap-3">
						<Button type="submit" busyLabel="Saving…">
							Save
						</Button>
						{plan && (
							<Button
								kind="secondary"
								href={`${action}/delete${via}`}
								{...sheetAttrs(`${action}/delete${via}`, false)}
								class="border-over text-over"
							>
								Delete
							</Button>
						)}
						<Button href={closeHref} kind="text">
							Cancel
						</Button>
					</div>
					{plan && !paidBy && (
						<p>
							<a
								href={`/plans/${plan.id}`}
								class="inline-flex min-h-11 items-center text-accent"
							>
								Link a payment
							</a>
						</p>
					)}
				</form>
			)}
			{/* Unlink's own form, outside the edit form (the Unlink button names it with `form`), so Enter in a field saves. */}
			{!deleteConfirm && paidBy && (
				<form
					id="plan-unlink"
					method="post"
					action={`${action}/unlink`}
					hx-post={`${action}/unlink`}
					hx-target="body"
					hx-swap="outerHTML"
				>
					{openerField}
				</form>
			)}
		</BottomSheet>
	);
}

/**
 * The plan's page, where its payment is linked (P101): the candidates, closest amount first, as radio chips, and one
 * Link button. A payment that pays a bill or another plan is never listed, so a link refused here says why.
 */
export function PlanPaymentPicker({
	planId,
	name,
	amountCents,
	candidates,
	error,
	focusHeading = false,
}: {
	planId: number;
	name: string;
	amountCents: number;
	candidates: {
		id: number;
		date: string;
		dateLabel: string;
		amountCents: number;
		displayName: string;
		excluded: boolean;
	}[];
	error?: string;
	/** The heading takes focus when the page is drawn: after an Unlink that changed nothing, which has no toast to say so. */
	focusHeading?: boolean;
}) {
	const action = `/plans/${planId}/link`;
	return (
		<section
			class="mt-6 border-t border-rule pt-4"
			aria-labelledby="plan-link-title"
		>
			<h2
				id="plan-link-title"
				class="font-serif text-3xl font-semibold"
				tabindex={focusHeading ? -1 : undefined}
				autofocus={focusHeading}
			>
				Link a payment
			</h2>
			<p class="mt-2 text-lg">
				To {name}, {formatCents(amountCents)}.
			</p>
			<p class="mt-1 text-muted">
				Money out in the planned expense's month and the next, closest amount
				first.
			</p>
			{error && (
				<p role="alert" class="mt-2 text-over">
					{error}
				</p>
			)}
			{candidates.length === 0 ? (
				<p class="mt-4 text-muted">No payments to link.</p>
			) : (
				<form
					method="post"
					action={action}
					hx-post={action}
					hx-target="body"
					hx-swap="outerHTML"
					class="mt-4 flex flex-col gap-3"
				>
					<fieldset>
						<legend>Payment</legend>
						<div class="mt-1">
							{candidates.slice(0, CLOSEST_PAYMENTS).map((candidate, index) => (
								<PaymentRow candidate={candidate} required={index === 0} />
							))}
							{candidates.length > CLOSEST_PAYMENTS && (
								<FoldedRow label={`Show all ${candidates.length} charges`}>
									{candidates.slice(CLOSEST_PAYMENTS).map((candidate) => (
										<PaymentRow candidate={candidate} />
									))}
								</FoldedRow>
							)}
						</div>
					</fieldset>
					<div>
						<Button type="submit" busyLabel="Linking…">
							Link payment
						</Button>
					</div>
				</form>
			)}
		</section>
	);
}
