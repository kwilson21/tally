import { formatCents } from "../money";
import { Icon } from "./icons";

export function SavingsGoalRow({
	amountCents,
	href,
	attrs,
	autofocus,
}: {
	amountCents: number | null;
	href: string;
	attrs?: Record<string, string>;
	autofocus?: boolean;
}) {
	const content = (
		<>
			<Icon name="bank" class="size-6 shrink-0 text-ink" />
			<span class="min-w-0 flex-1 truncate text-lg">Savings</span>
			{amountCents !== null && amountCents > 0 ? (
				<span class="tabular-nums">
					{formatCents(amountCents, { wholeDollars: amountCents % 100 === 0 })}
					<span class="ml-1 text-muted">a month</span>
				</span>
			) : (
				<span class="text-accent">Set a goal</span>
			)}
		</>
	);
	return (
		<li>
			<a
				href={href}
				autofocus={autofocus}
				class="flex min-h-11 items-center gap-4 py-2 text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				{...attrs}
			>
				{content}
			</a>
			{amountCents !== null && amountCents > 0 && (
				<p class="-mt-2 pb-2 pl-10 text-sm text-muted">
					Set aside from Safe to spend
				</p>
			)}
		</li>
	);
}
