import { formatCents } from "../money";
import { Button } from "./button";
import { Chip } from "./chip";
import { EmptyState } from "./empty-state";

export type PaymentPickerCandidate = {
	id: number;
	displayName: string;
	date: string;
	dateLabel: string;
	amountCents: number;
};
export type PaymentPickerPeriod = {
	value: string;
	label: string;
	countedMonth: string;
};

const month = (value: string) =>
	new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
		new Date(`${value}-01T00:00:00Z`),
	);

export function BillMonthExplanation({
	countedMonth,
	paymentDate,
}: {
	countedMonth: string;
	paymentDate: string;
}) {
	const bankMonth = paymentDate.slice(0, 7);
	const bankName = month(bankMonth);
	return (
		<p class="text-sm text-muted">
			{countedMonth < bankMonth
				? `It counts in ${month(countedMonth)}'s spending, not ${bankName}'s. The bank's date stays ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${paymentDate}T00:00:00Z`))}.`
				: `It counts in ${bankName}'s spending, its bank month.`}
		</p>
	);
}

/** Bill page's hand-link picker. It is also rendered, inert, in the catalog. */
export function BillPaymentPicker({
	billId,
	billName,
	billAmountCents,
	openedPeriod,
	dueDateLabel,
	candidates,
	periods,
	selectedTransactionId,
}: {
	billId: number;
	billName: string;
	billAmountCents: number;
	openedPeriod: string;
	dueDateLabel: string;
	candidates: PaymentPickerCandidate[];
	periods: PaymentPickerPeriod[];
	selectedTransactionId?: number;
}) {
	const action = `/bills/${billId}/link`;
	const opened =
		periods.find((period) => period.value === openedPeriod) ?? periods[0];
	const selectedPayment = candidates.find(
		(candidate) => candidate.id === selectedTransactionId,
	);
	return (
		<section
			id="payment-picker"
			tabindex={-1}
			autofocus
			class="mt-6 border-t border-rule pt-4"
		>
			<h2 class="font-serif text-3xl font-semibold">Link a payment</h2>
			<p class="mt-2 text-lg">
				To {opened?.label ?? openedPeriod}'s {billName},{" "}
				{formatCents(billAmountCents)}.
			</p>
			<p class="mt-1 text-muted">
				Within 30 days of {dueDateLabel}, same merchant first, then closest
				amount.
			</p>
			{candidates.length ? (
				<form
					method="post"
					action={action}
					hx-post={action}
					hx-target="body"
					hx-swap="outerHTML"
					class="mt-4 flex flex-col gap-3"
				>
					<input type="hidden" name="opened_period" value={openedPeriod} />
					<fieldset>
						<legend>Payment</legend>
						<div class="mt-1 flex flex-col gap-2">
							{candidates.map((t, index) => (
								<Chip
									type="radio"
									name="transaction_id"
									value={String(t.id)}
									// Nothing is chosen for the person; one required radio makes the group required.
									required={index === 0}
									checked={t.id === selectedTransactionId}
									hx-get={`/bills/${billId}/month-explanation`}
									hx-include="[name='transaction_id'],[name='period']"
									hx-target="#bill-month-explanation"
									hx-swap="innerHTML"
								>
									{t.displayName} · {t.dateLabel} · {formatCents(t.amountCents)}
								</Chip>
							))}
						</div>
					</fieldset>
					<fieldset>
						<legend>Which month's bill does it pay?</legend>
						<div class="mt-2 flex flex-wrap gap-2">
							{periods.map((period) => (
								<Chip
									type="radio"
									name="period"
									value={period.value}
									checked={period.value === opened?.value}
									hx-get={`/bills/${billId}/occurrences/${encodeURIComponent(period.value)}/link`}
									hx-include="[name='transaction_id'],[name='period']"
									hx-target="#payment-picker"
									hx-swap="outerHTML"
								>
									{period.label}
								</Chip>
							))}
						</div>
						<div id="bill-month-explanation" aria-live="polite">
							{opened && selectedPayment ? (
								<BillMonthExplanation
									countedMonth={opened.countedMonth}
									paymentDate={selectedPayment.date}
								/>
							) : (
								<p class="text-sm text-muted">
									A late payment counts in its bill's month; an early one stays
									in the month it was paid.
								</p>
							)}
						</div>
					</fieldset>
					<div class="flex gap-3">
						<Button type="submit">Link</Button>
						<Button kind="text" href={`/bills/${billId}`}>
							Cancel
						</Button>
					</div>
				</form>
			) : (
				<EmptyState
					kind="search"
					sentence="No payments to link"
					hint="There are no eligible, unclaimed payments within 30 days."
				/>
			)}
		</section>
	);
}
