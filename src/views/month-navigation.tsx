import { monthLabel, monthName, monthsBefore } from "../dates";
import { Icon } from "./icons";

function Arrow({
	direction,
	target,
	currentMonth,
}: {
	direction: "previous" | "next";
	target?: string;
	currentMonth: string;
}) {
	const name = direction === "previous" ? "Previous" : "Next";
	const label = `${name} month, ${monthLabel(target ?? currentMonth, currentMonth)}`;
	const icon = (
		<Icon
			name="chevron-right"
			class={`size-6 ${direction === "previous" ? "rotate-180" : ""}`}
		/>
	);
	return target ? (
		<a
			href={`/?month=${target}`}
			aria-label={label}
			class="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-muted text-ink no-underline"
		>
			{icon}
		</a>
	) : (
		<span
			aria-hidden="true"
			class="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-dashed border-rule text-muted/40"
		>
			{icon}
		</span>
	);
}

/** No-JavaScript links across the household's counted transaction months. */
export function MonthNavigation({
	month,
	firstMonth,
	currentMonth,
}: {
	month: string;
	firstMonth: string;
	currentMonth: string;
}) {
	const firstRenderedMonth =
		month < monthsBefore(currentMonth, 35)
			? monthsBefore(month, 35)
			: firstMonth > monthsBefore(currentMonth, 35)
				? firstMonth
				: monthsBefore(currentMonth, 35);
	const lastRenderedMonth =
		month < monthsBefore(currentMonth, 35) ? month : currentMonth;
	const renderedCount =
		(Number(lastRenderedMonth.slice(0, 4)) -
			Number(firstRenderedMonth.slice(0, 4))) *
			12 +
		Number(lastRenderedMonth.slice(5, 7)) -
		Number(firstRenderedMonth.slice(5, 7));
	const months = Array.from(
		{ length: Math.min(36, Math.max(0, renderedCount) + 1) },
		(_, index) => monthsBefore(lastRenderedMonth, renderedCount - index),
	);
	const previous = month > firstMonth ? monthsBefore(month, 1) : undefined;
	const next = month < currentMonth ? monthsBefore(month, -1) : undefined;
	return (
		<div>
			<div class="flex items-center gap-3">
				<Arrow
					direction="previous"
					target={previous}
					currentMonth={currentMonth}
				/>
				<h1 class="font-serif text-2xl font-semibold tracking-tight">
					{monthLabel(month, currentMonth)}
				</h1>
				<Arrow direction="next" target={next} currentMonth={currentMonth} />
			</div>
			<nav aria-label="Months" class="mt-2">
				<ol class="flex flex-wrap">
					{months.map((item) => {
						const current = item === currentMonth;
						const selected = item === month;
						const label = monthLabel(item, currentMonth);
						return (
							<li>
								<a
									href={`/?month=${item}`}
									aria-current={selected ? "page" : undefined}
									class="flex min-h-11 w-11 flex-col items-center gap-0.5 text-sm text-muted no-underline"
								>
									<span
										aria-hidden="true"
										class={`size-8 rounded-full ${selected ? "bg-ink" : "bg-muted/45"} ${current ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : ""}`}
									/>
									<span aria-hidden="true">{monthName(item).slice(0, 3)}</span>
									<span class="sr-only">{`${label}${current ? ", this month" : ""}`}</span>
								</a>
							</li>
						);
					})}
				</ol>
			</nav>
			{firstMonth < firstRenderedMonth && (
				<a
					href={`/?month=${monthsBefore(firstRenderedMonth, 1)}`}
					class="mt-1 inline-flex min-h-11 items-center text-sm text-muted no-underline"
				>
					Earlier
				</a>
			)}
			{lastRenderedMonth < currentMonth && (
				<a
					href={`/?month=${monthsBefore(lastRenderedMonth, -1)}`}
					class="mt-1 inline-flex min-h-11 items-center text-sm text-muted no-underline"
				>
					Later
				</a>
			)}
		</div>
	);
}
