import type { BillSuggestion } from "../bills/find";
import { formatCents } from "../money";
import { Button } from "./button";
import { Icon } from "./icons";

export function BillFindingBand({ count }: { count: number }) {
	if (!count) return null;
	return (
		<a
			href="/bills/find"
			class="mt-4 flex min-h-11 items-center gap-3 border-l-4 border-accent bg-band px-4 py-3 text-ink no-underline focus-visible:outline-2 focus-visible:outline-accent"
		>
			<Icon name="bills" class="size-7 shrink-0" />
			<span class="min-w-0 flex-1">
				<span class="block text-lg font-semibold">
					{count} possible {count === 1 ? "bill" : "bills"} found
				</span>
				<span class="block text-muted">
					From repeat charges in the last 3 months
				</span>
			</span>
			<Icon name="chevron" />
		</a>
	);
}
const ordinal = (day: number) =>
	`${day}${day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}`;
export function BillFindingRow({ suggestion }: { suggestion: BillSuggestion }) {
	const query = new URLSearchParams({
		name: suggestion.displayName,
		amount: (suggestion.amountCents / 100).toFixed(2),
		due_day: String(suggestion.dueDay),
		frequency: "monthly",
		category_id: String(suggestion.categoryId ?? ""),
		merchant_raw_name: suggestion.rawName,
	});
	return (
		<li id={`finding-${encodeURIComponent(suggestion.rawName)}`} class="py-3">
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="font-semibold">{suggestion.displayName}</p>
					<p class="text-muted">
						{formatCents(suggestion.amountCents)} · about monthly, around the{" "}
						{ordinal(suggestion.dueDay)}
					</p>
				</div>
			</div>
			<div class="mt-2 flex items-center gap-3">
				<Button kind="secondary" href={`/bills/new?${query}`}>
					Add
				</Button>
				<Button
					kind="text"
					type="button"
					hx-post={`/bills/find/${encodeURIComponent(suggestion.rawName)}/dismiss`}
					hx-target="closest li"
					hx-swap="outerHTML"
				>
					Not a bill
				</Button>
			</div>
		</li>
	);
}
