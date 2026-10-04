import { formatCents } from "../money";
import { Button } from "./button";
import { Chip } from "./chip";
import { EmptyState } from "./empty-state";

export type PaymentPickerCandidate = {
	id: number;
	displayName: string;
	dateLabel: string;
	amountCents: number;
};
export type PaymentPickerPeriod = { value: string; label: string };

/** Bill page's hand-link picker. It is also rendered, inert, in the catalog. */
export function BillPaymentPicker({
	billId,
	billName,
	billAmountCents,
	openedPeriod,
	candidates,
	periods,
}: {
	billId: number;
	billName: string;
	billAmountCents: number;
	openedPeriod: string;
	candidates: PaymentPickerCandidate[];
	periods: PaymentPickerPeriod[];
}) {
	const action = `/bills/${billId}/link`;
	return (
		<section
			id="payment-picker"
			tabindex={-1}
			autofocus
			class="mt-6 border-t border-rule pt-4"
		>
			<h2 class="font-serif text-3xl font-semibold">Link a payment</h2>
			<p class="mt-2">
				Within 30 days, same merchant first, then closest amount.
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
									checked={index === 0}
								>
									{t.displayName} · {t.dateLabel} · {formatCents(t.amountCents)}
								</Chip>
							))}
						</div>
					</fieldset>
					<fieldset>
						<legend>Which month's bill does it pay?</legend>
						<p class="text-sm text-muted">
							A late payment counts in its bill's month; an early one stays in
							the month it was paid.
						</p>
						<div class="mt-2 flex flex-wrap gap-2">
							{periods.map((period) => (
								<Chip
									type="radio"
									name="period"
									value={period.value}
									checked={period.value === openedPeriod}
								>
									{period.label}
								</Chip>
							))}
						</div>
					</fieldset>
					<p class="text-sm text-muted">
						To {openedPeriod}'s {billName}, {formatCents(billAmountCents)} ·
						within 30 days
					</p>
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
