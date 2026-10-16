import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import type { OccurrencePayment } from "./bill-occurrence-row";
import { Button } from "./button";
import { Icon, ROW_OPENS, RowArrow } from "./icons";

/** A paid month's check, hidden from a screen reader: its words say Paid. */
export function PaidCheck() {
	return (
		<span class="text-ok" aria-hidden="true">
			<Icon name="check" class="size-4" />
		</span>
	);
}

/**
 * A bill's head (P120 B, decision 111, P131 A): the name is the one headline, its amount and due day in muted words
 * under it, a price-change note (`note`) under the amount, and the bank's text small at the foot. `titleId` puts the
 * page's own id on the name.
 */
export function BillHead({
	name,
	amount,
	note,
	bankText,
	titleId,
}: {
	name: string;
	amount: string;
	note?: Child;
	bankText: string;
	titleId?: string;
}) {
	return (
		<div class="flex flex-col gap-1">
			<h1 id={titleId} class="font-serif text-3xl font-semibold tracking-tight">
				{name}
			</h1>
			<p class="text-muted">{amount}</p>
			{note}
			<p class="text-sm text-muted">{bankText}</p>
		</div>
	);
}

/**
 * One month as a quiet ruled row that opens a link (P118 A, P131 A): its name, its status in muted words at the
 * right, and the row's arrow. `sub` is a second line under the name (a found charge's sentence) and `action` a word
 * in place of the words (a terracotta Link it). The whole row is one link, at least 44px tall, that j and k move
 * between (#639).
 */
export function LedgerMonth({
	href,
	month,
	words,
	wordsClass = "text-muted",
	sub,
	action,
}: {
	href: string;
	month: string;
	words?: Child;
	wordsClass?: string;
	sub?: Child;
	action?: Child;
}) {
	return (
		<li>
			<a
				href={href}
				class={`flex min-h-11 items-center gap-3 py-2 text-ink no-underline ${ROW_OPENS}`}
				data-row=""
			>
				<span class="min-w-0 flex-1">
					<span class="block text-lg">{month}</span>
					{sub && <span class="block text-sm text-muted">{sub}</span>}
				</span>
				{words && <span class={`text-sm ${wordsClass}`}>{words}</span>}
				{action}
				<RowArrow />
			</a>
		</li>
	);
}

/**
 * A month with payments, or a run of months with none (P131 A): a native disclosure whose row ends in the arrow,
 * which turns when it opens. `sr` says the count of a folded run to a screen reader, where the words are hidden,
 * and `open` opens it, so a payment whose Not this one takes focus is never inside a closed row.
 */
export function LedgerDisclosure({
	month,
	words,
	mark,
	sr,
	open = false,
	children,
}: {
	month: string;
	words: Child;
	/** A status mark (a paid month's check), hung in the margin left of the name (decision 125). */
	mark?: Child;
	sr?: string;
	open?: boolean;
	children?: Child;
}) {
	return (
		<li>
			<details class="group" open={open}>
				<summary
					class={`flex min-h-11 cursor-pointer list-none items-center gap-3 py-2 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden ${ROW_OPENS}`}
				>
					<span class="relative min-w-0 flex-1 text-lg">
						{mark && (
							<span class="absolute -left-5 top-1/2 flex -translate-y-1/2 [&_svg]:block">
								{mark}
							</span>
						)}
						{month}
						{sr && <span class="sr-only">{`, ${sr}`}</span>}
					</span>
					<span
						class="text-sm text-muted"
						aria-hidden={sr ? "true" : undefined}
					>
						{words}
					</span>
					<RowArrow class="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
				</summary>
				{children && <div class="pb-3">{children}</div>}
			</details>
		</li>
	);
}

/**
 * A month's payments, each with its own Not this one (decision 101, #340): the payment's line, then the form that
 * unlinks it, which takes focus when an Undo has just linked it again. Each form posts to the page's own #page.
 */
export function LedgerPayments({
	billId,
	period,
	payments,
	focusTransactionId,
}: {
	billId: number;
	period: string;
	payments: OccurrencePayment[];
	focusTransactionId?: number;
}) {
	const unlink = `/bills/${billId}/occurrences/${period}/unlink`;
	return (
		<>
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
		</>
	);
}

/** A month a payment came at another price: its name and words, then the question the PriceChanged block asks. */
export function LedgerPriceRow({
	month,
	words,
	children,
}: {
	month: string;
	words: Child;
	children?: Child;
}) {
	return (
		<li class="py-2">
			<p class="flex justify-between gap-3">
				<span class="text-lg">{month}</span>
				<span class="text-sm text-muted">{words}</span>
			</p>
			{children}
		</li>
	);
}
