import { formatCents } from "../money";
import { Icon, ROW_OPENS, RowArrow } from "./icons";
import { type SavedMark, savedRowClass } from "./saved-tick";

export function SavingsGoalRow({
	amountCents,
	href,
	attrs,
	autofocus,
	saved,
}: {
	amountCents: number | null;
	href?: string;
	attrs?: Record<string, string>;
	autofocus?: boolean;
	/** The goal a save just set: its arrow gives way to the pencil tick (P119 A, #71). */
	saved?: SavedMark;
}) {
	// Set a goal ends in terracotta words, so only a set goal's row takes the arrow and the press (P118 A).
	const goalSet = amountCents !== null && amountCents > 0;
	// Only a set goal has an arrow for the tick to take (P119 A, #71).
	const mark = goalSet ? saved : undefined;
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
					class={`flex min-h-11 items-start gap-4 py-3 text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent${goalSet ? ` ${ROW_OPENS}` : ""}${mark ? ` ${savedRowClass(mark)}` : ""}`}
					{...attrs}
				>
					{content}
					{goalSet && <RowArrow class="self-start mt-1" saved={mark} />}
				</a>
			) : (
				<div class="flex min-h-11 items-start gap-4 py-3 text-ink">
					{content}
				</div>
			)}
		</li>
	);
}
