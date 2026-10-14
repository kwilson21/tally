import { formatCents } from "../money";
import { Icon, ROW_OPENS, RowArrow } from "./icons";

export function SavingsGoalRow({
	amountCents,
	href,
	attrs,
	autofocus,
}: {
	amountCents: number | null;
	href?: string;
	attrs?: Record<string, string>;
	autofocus?: boolean;
}) {
	// Set a goal ends in terracotta words, so only a set goal's row takes the arrow and the press (P118 A).
	const goalSet = amountCents !== null && amountCents > 0;
	const content = (
		<>
			<span class="shrink-0 text-ink">
				<Icon name="bank" class="size-7" />
			</span>
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-baseline justify-between gap-x-3">
					<span class="text-lg">Savings</span>
					{amountCents !== null && amountCents > 0 ? (
						<span class="ml-auto text-right text-lg">
							{formatCents(amountCents, {
								wholeDollars: amountCents % 100 === 0,
							})}{" "}
							<span class="text-muted">a month</span>
						</span>
					) : (
						<span class="ml-auto text-right text-lg text-accent">
							Set a goal
						</span>
					)}
				</div>
				{goalSet && <p class="text-muted">Set aside from Safe to spend</p>}
			</div>
		</>
	);
	return (
		<li>
			{href ? (
				<a
					href={href}
					autofocus={autofocus}
					class={`flex min-h-11 items-start gap-4 py-3 text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent${goalSet ? ` ${ROW_OPENS}` : ""}`}
					{...attrs}
				>
					{content}
					{goalSet && <RowArrow class="self-start mt-1" />}
				</a>
			) : (
				<div class="flex min-h-11 items-start gap-4 py-3 text-ink">
					{content}
				</div>
			)}
		</li>
	);
}
