import { manualLinkWindowDays } from "../bills/status";
import { billPaymentMonth, type CountedBill } from "../db/counted-month";
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
	/** The person said Not this one to it for this month: it is listed last, under "You said not this one" (#340). */
	turnedAway?: boolean;
};
export type PaymentPickerPeriod = {
	value: string;
	label: string;
};

/** The count a month choice announces: "2 payments to link", or none. */
export const paymentCountSentence = (count: number) =>
	count === 0
		? "No payments to link"
		: `${count} ${count === 1 ? "payment" : "payments"} to link`;

const month = (value: string) =>
	new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(
		new Date(`${value}-01T00:00:00Z`),
	);

/** Which month a linked payment counts in, in words, from the same rule the totals use (billPaymentMonth). */
export function BillMonthExplanation({
	bill,
	period,
	paymentDate,
}: {
	bill: CountedBill;
	period: string;
	paymentDate: string;
}) {
	const bankMonth = paymentDate.slice(0, 7);
	const countedMonth = billPaymentMonth(bill, period, bankMonth);
	const bankName = month(bankMonth);
	return (
		<p class="text-sm text-muted">
			{countedMonth !== bankMonth
				? `It counts in ${month(countedMonth)}'s spending, not ${bankName}'s. The bank's date stays ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${paymentDate}T00:00:00Z`))}.`
				: `It counts in ${bankName}'s spending, its bank month.`}
		</p>
	);
}

/** One payment as a radio chip. The first chip in the list is required, so the group needs a choice. */
function PaymentChip({
	billId,
	candidate,
	index,
	selectedTransactionId,
}: {
	billId: number;
	candidate: PaymentPickerCandidate;
	index: number;
	selectedTransactionId?: number;
}) {
	return (
		<Chip
			type="radio"
			name="transaction_id"
			value={String(candidate.id)}
			// Nothing is chosen for the person; one required radio makes the group required.
			required={index === 0}
			checked={candidate.id === selectedTransactionId}
			hx-get={`/bills/${billId}/month-explanation`}
			hx-include="[name='transaction_id'],[name='period']"
			hx-target="#bill-month-explanation"
			hx-swap="innerHTML"
		>
			{`${candidate.displayName} · ${candidate.dateLabel} · ${formatCents(candidate.amountCents)}${candidate.excluded ? " · Excluded" : ""}`}
		</Chip>
	);
}

/** Bill page's hand-link picker. It is also rendered, inert, in the catalog. */
export function BillPaymentPicker({
	billId,
	billName,
	billAmountCents,
	openedPeriod,
	dueDateLabel,
	bill,
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
	bill: CountedBill;
	candidates: PaymentPickerCandidate[];
	periods: PaymentPickerPeriod[];
	selectedTransactionId?: number;
	/** True when a month chip swapped this picker in: focus stays on the chosen month, not the section. */
	rerender?: boolean;
}) {
	const action = `/bills/${billId}/link`;
	const windowDays = manualLinkWindowDays(bill.frequency);
	const opened =
		periods.find((period) => period.value === openedPeriod) ?? periods[0];
	const selectedPayment = candidates.find(
		(candidate) => candidate.id === selectedTransactionId,
	);
	const emptyState = (
		<EmptyState
			kind="search"
			sentence="No payments to link"
			hint={`There are no eligible, unclaimed payments within ${windowDays} days.`}
		/>
	);
	// A page that opens on a month with nothing to link shows the empty state alone. Once a payment is listed, or a
	// month choice has swapped the picker in (rerender), the month choices stay, so another month can still be picked.
	const monthChoices = candidates.length > 0 || rerender;
	// Link it's found charge, or any payment named in the address, leads the list so it opens checked and first (#604).
	const ordered =
		selectedPayment && !selectedPayment.turnedAway
			? [
					selectedPayment,
					...candidates.filter((candidate) => candidate !== selectedPayment),
				]
			: candidates;
	// A turned-away payment comes last, under its own muted line; each keeps its place in the list, so the first is required.
	const listed = ordered.map((candidate, index) => ({ candidate, index }));
	const regular = listed.filter(({ candidate }) => !candidate.turnedAway);
	const turnedAway = listed.filter(({ candidate }) => candidate.turnedAway);
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
			{monthChoices ? (
				<form
					method="post"
					action={action}
					hx-post={action}
					hx-target="body"
					hx-swap="outerHTML"
					class="mt-4 flex flex-col gap-3"
				>
					<input type="hidden" name="opened_period" value={openedPeriod} />
					{candidates.length ? (
						<fieldset>
							<legend>Payment</legend>
							<div class="mt-1 flex flex-col gap-2">
								{regular.map(({ candidate, index }) => (
									<PaymentChip
										billId={billId}
										candidate={candidate}
										index={index}
										selectedTransactionId={selectedTransactionId}
									/>
								))}
								{turnedAway.length ? (
									<fieldset class="flex flex-col gap-2">
										<legend class="text-sm text-muted">
											You said not this one
										</legend>
										{turnedAway.map(({ candidate, index }) => (
											<PaymentChip
												billId={billId}
												candidate={candidate}
												index={index}
												selectedTransactionId={selectedTransactionId}
											/>
										))}
									</fieldset>
								) : null}
							</div>
						</fieldset>
					) : (
						emptyState
					)}
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
							{opened && selectedPayment ? (
								<BillMonthExplanation
									bill={bill}
									period={opened.value}
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
					{candidates.length ? (
						<div class="flex gap-3">
							<Button type="submit">Link</Button>
							<Button kind="text" href={`/bills/${billId}`}>
								Cancel
							</Button>
						</div>
					) : null}
				</form>
			) : (
				emptyState
			)}
		</section>
	);
}
