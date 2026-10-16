import { type BillStatus, partPaidSentence } from "../bills/status";
import { formatCents } from "../money";
import { Button } from "./button";
import { Icon } from "./icons";

export type OccurrencePayment = {
	/** The payment's transaction id, which its own Not this one sends (a month can hold several). */
	transactionId: number;
	displayName: string;
	dateLabel: string;
	amountCents: number;
	matchedBy: "auto" | "user";
};

/** A payment from the bill's merchant at another price, asked about on the occurrence it would pay (P36 B). */
export type OccurrencePriceOffer = {
	transactionId: number;
	/** Who charged it, as a person knows the merchant ("Netflix"). */
	merchant: string;
	amountCents: number;
	dateLabel: string;
	/** The occurrence's own amount, which the charge is asked against. */
	billAmountCents: number;
	/** The bill's current amount (`bills.amount_cents`), which Yes checks is still the one shown. */
	currentCents: number;
	frequency: "monthly" | "yearly" | "weekly" | "biweekly" | "quarterly";
	cadence?: string;
};

const statusLabel: Record<BillStatus | "not-paid", string> = {
	paid: "Paid",
	overdue: "Overdue",
	due: "Due",
	upcoming: "Upcoming",
	"not-paid": "Not paid",
};

const statusLook = {
	paid: { icon: "check", tone: "text-ok" },
	overdue: { icon: "alert", tone: "text-over" },
	due: { icon: "bills", tone: "text-ink" },
	upcoming: { icon: "bills", tone: "text-muted" },
	"not-paid": { icon: "bills", tone: "text-muted" },
} as const;

export function StatusTag({ status }: { status: BillStatus | "not-paid" }) {
	const look = statusLook[status];
	return (
		<span class="inline-flex shrink-0 items-center gap-1 rounded-control bg-band px-2 text-sm text-ink">
			<span class={look.tone}>
				<Icon name={look.icon} class="size-4" />
			</span>
			{statusLabel[status]}
		</span>
	);
}

/**
 * The question in place of "Link a payment" (P36 B, decision 72): what was charged against what the bill
 * says, what updating does, one primary action and "Not this bill" as terracotta text. Each is its own
 * form, so both work without JavaScript, and the payment's id travels with them so a stale page can't
 * answer for another payment.
 */
export function PriceChanged({
	billId,
	period,
	offer,
}: {
	billId: number;
	period: string;
	offer: OccurrencePriceOffer;
}) {
	const answer = (verb: "accept" | "dismiss") =>
		`/bills/${billId}/occurrences/${period}/price/${verb}`;
	const charged = formatCents(offer.amountCents);
	return (
		<>
			<p class="mt-1 text-lg">
				{`${offer.merchant} charged ${charged} on ${offer.dateLabel}, not ${formatCents(offer.billAmountCents)}.`}
			</p>
			<p class="text-muted">
				{`Updating the bill links that payment and makes it ${charged} ${offer.cadence ?? (offer.frequency === "monthly" ? "a month" : offer.frequency === "yearly" ? "a year" : offer.frequency === "biweekly" ? "every two weeks" : offer.frequency === "quarterly" ? "every 3 months" : "a week")}.`}
			</p>
			<form
				method="post"
				action={answer("accept")}
				hx-post={answer("accept")}
				hx-target="body"
				hx-swap="outerHTML"
				class="mt-3"
			>
				<input
					type="hidden"
					name="transaction_id"
					value={offer.transactionId}
				/>
				{/* The prices shown above, in whole cents: the server saves only while all of them still hold. */}
				<input type="hidden" name="bill_cents" value={offer.billAmountCents} />
				<input type="hidden" name="charge_cents" value={offer.amountCents} />
				<input type="hidden" name="current_cents" value={offer.currentCents} />
				<Button type="submit" busyLabel="Updating…">
					{`Update the bill to ${charged}`}
				</Button>
			</form>
			<form
				method="post"
				action={answer("dismiss")}
				hx-post={answer("dismiss")}
				hx-target="body"
				hx-swap="outerHTML"
			>
				<input
					type="hidden"
					name="transaction_id"
					value={offer.transactionId}
				/>
				<Button kind="text" type="submit" class="-ml-2">
					Not this bill
				</Button>
			</form>
		</>
	);
}

/**
 * One occurrence on a bill page, with its real link and unlink controls. Its payments are each listed with their
 * own Not this one (decision 101). A part-paid occurrence says what it has, "Part paid: $600 of $1,200", and offers
 * "Link another payment"; a Paid one with several payments says "Paid in 2 payments". A month whose payments count $0,
 * such as a payment a bank corrected into a credit, reads as unpaid: no part-paid line, and "Link a payment" (#469).
 */
export function BillOccurrenceRow({
	billId,
	period,
	label,
	status,
	payments = [],
	paidCents = 0,
	amountCents = 0,
	priceOffer,
	focusTransactionId,
}: {
	billId: number;
	period: string;
	label: string;
	status: BillStatus | "not-paid";
	payments?: OccurrencePayment[];
	/** What the payments add up to, and the occurrence's amount: the part-paid line reads both. */
	paidCents?: number;
	amountCents?: number;
	priceOffer?: OccurrencePriceOffer | null;
	/** The payment whose Not this one takes focus when the page arrives, as after an Undo that linked it again (#340). */
	focusTransactionId?: number;
}) {
	const unlink = `/bills/${billId}/occurrences/${period}/unlink`;
	const link = `/bills/${billId}/occurrences/${period}/link#payment-picker`;
	if (priceOffer && !payments.length)
		return (
			<li class="py-2">
				<p class="flex justify-between gap-3">
					<span class="text-lg">{label}</span>
					<StatusTag status={status} />
				</p>
				<PriceChanged billId={billId} period={period} offer={priceOffer} />
			</li>
		);
	// The clamped total decides, as the Bills row's does: a month whose payments count $0 reads as unpaid (#469).
	const partPaid = paidCents > 0 && status !== "paid";
	return (
		<li class="py-2">
			<p class="flex justify-between gap-3">
				<span class="text-lg">{label}</span>
				<StatusTag status={status} />
			</p>
			{partPaid && (
				<p class="text-lg">{partPaidSentence(paidCents, amountCents)}</p>
			)}
			{status === "paid" && payments.length > 1 && (
				<p class="text-lg">{`Paid in ${payments.length} payments`}</p>
			)}
			{payments.length === 0 && <p class="text-muted">No payment linked yet</p>}
			{payments.map((payment) => (
				<>
					<p class="text-muted">
						{`${payment.displayName} · ${payment.dateLabel} · ${formatCents(payment.amountCents)}${payment.matchedBy === "user" ? " · by hand" : ""}`}
					</p>
					<form
						method="post"
						action={unlink}
						hx-post={unlink}
						hx-target="#page"
						hx-select="#page"
						hx-swap="outerHTML"
					>
						<input
							type="hidden"
							name="transaction_id"
							value={payment.transactionId}
						/>
						<Button
							kind="text"
							type="submit"
							class="-ml-2"
							autofocus={payment.transactionId === focusTransactionId}
							aria-label={`Not this one: ${payment.displayName} ${formatCents(payment.amountCents)} on ${payment.dateLabel}`}
						>
							Not this one
						</Button>
					</form>
				</>
			))}
			{status !== "paid" && (
				<Button kind="text" class="-ml-2" href={link}>
					{partPaid ? "Link another payment" : "Link a payment"}
				</Button>
			)}
		</li>
	);
}
