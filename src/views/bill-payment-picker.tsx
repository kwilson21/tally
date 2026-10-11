import { manualLinkWindowDays } from "../bills/status";
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
	/** An excluded payment can pay a bill, and counts in the budget once linked (spec §6.1 rule 4, §8.5). */
	excluded?: boolean;
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
	frequency,
	candidates,
	periods,
	selectedTransactionId,
	rerender = false,
}: {
	billId: number;
	billName: string;
	billAmountCents: number;
	openedPeriod: string;
	dueDateLabel: string;
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	candidates: PaymentPickerCandidate[];
	periods: PaymentPickerPeriod[];
	selectedTransactionId?: number;
	/** True when a month chip swapped this picker in: focus stays on the chosen month, not the section. */
	rerender?: boolean;
}) {
	const action = `/bills/${billId}/link`;
	const windowDays = manualLinkWindowDays(frequency);
	const opened =
		periods.find((period) => period.value === openedPeriod) ?? periods[0];
	const selectedPayment = candidates.find(
		(candidate) => candidate.id === selectedTransactionId,
	);
	const count = candidates.length;
	const countSentence =
		count === 0
			? "No payments to link"
			: `${count} ${count === 1 ? "payment" : "payments"} to link`;
	return (
		<section
			id="payment-picker"
			tabindex={-1}
			autofocus={!rerender}
			class="mt-6 border-t border-rule pt-4"
		>
			<h2 class="font-serif text-3xl font-semibold">Link a payment</h2>
			<p class="mt-2 text-lg">
				To {opened?.label ?? openedPeriod}'s {billName},{" "}
				{formatCents(billAmountCents)}.
			</p>
			<p class="mt-1 text-muted">
				Within {windowDays} days of {dueDateLabel}, same merchant first, then
				closest amount.
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
									{`${t.displayName} · ${t.dateLabel} · ${formatCents(t.amountCents)}${t.excluded ? " · Excluded" : ""}`}
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
									autofocus={rerender && period.value === opened?.value}
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
							<span class="sr-only">{countSentence}</span>
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
					hint={`There are no eligible, unclaimed payments within ${windowDays} days.`}
				/>
			)}
		</section>
	);
}
