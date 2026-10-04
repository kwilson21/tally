import { BILL_FIND_MONTHS, type BillSuggestion } from "../bills/find";
import { ordinal } from "../dates";
import { centsToAmount, formatCents } from "../money";
import { Button } from "./button";
import { Icon } from "./icons";

export function BillFindingBand({ count }: { count: number }) {
	if (!count) return null;
	return (
		<a
			href="/bills/find"
			class="mt-4 flex min-h-11 items-center justify-between gap-3 border-l-4 border-accent bg-band px-4 py-3 text-ink no-underline focus-visible:outline-2 focus-visible:outline-accent"
		>
			<Icon name="bills" class="size-7 shrink-0" />
			<span class="min-w-0 flex-1">
				<span class="block text-lg font-semibold">
					{count} possible {count === 1 ? "bill" : "bills"} found
				</span>
				<span class="block text-base text-muted">
					From repeat charges in the last {BILL_FIND_MONTHS} months
				</span>
			</span>
			<Icon name="chevron" />
		</a>
	);
}
export function BillFindingRow({
	suggestion,
	focusAdd = false,
}: {
	suggestion: BillSuggestion;
	focusAdd?: boolean;
}) {
	const query = new URLSearchParams({
		name: suggestion.displayName,
		amount: centsToAmount(suggestion.amountCents),
		due_day: String(suggestion.dueDay),
		frequency: "monthly",
		category_id: String(suggestion.categoryId ?? ""),
		merchant_raw_name: suggestion.rawName,
	});
	return (
		<li id={`finding-${encodeURIComponent(suggestion.rawName)}`} class="py-3">
			<p class="flex items-baseline justify-between gap-3 text-lg">
				<span>{suggestion.displayName}</span>
				<span class="shrink-0 text-right">
					About {formatCents(suggestion.amountCents)}
				</span>
			</p>
			<p class="text-sm text-muted">
				{suggestion.rawName} · {suggestion.chargeCount} charges, around the{" "}
				{ordinal(suggestion.dueDay)}
			</p>
			<div class="mt-2 flex items-center gap-3">
				<Button
					kind="secondary"
					href={`/bills/new?${query}`}
					autofocus={focusAdd || undefined}
				>
					Add
				</Button>
				<form
					method="post"
					action={`/bills/find/${encodeURIComponent(suggestion.rawName)}/dismiss`}
					hx-post={`/bills/find/${encodeURIComponent(suggestion.rawName)}/dismiss`}
					hx-target="#bill-finding-list"
					hx-swap="outerHTML"
				>
					<Button kind="text" type="submit">
						Not a bill
					</Button>
				</form>
			</div>
		</li>
	);
}
