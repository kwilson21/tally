import { monthLabel, monthName, monthsBefore } from "../dates";
import { wholeUnlessTiny } from "../money";
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
			// keyboard.js presses this with the arrow key (decision 118).
			aria-keyshortcuts={direction === "previous" ? "ArrowLeft" : "ArrowRight"}
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

/** What a month's dot says about how it ended (P133 A): a check, a minus or an empty ring, or the current month. */
export type MonthMark = "under" | "over" | "empty" | "current";

/** A month's mark from its result (null for a month with no budgets); the current month, still going, has none. */
export function monthMark(result: number | null, current: boolean): MonthMark {
	if (current) return "current";
	if (result === null) return "empty";
	return result < 0 ? "over" : "under";
}

/**
 * A month's link name for a screen reader, its result in words (P133 A): "September, ended $2,134 over",
 * "May, ended $310 under", "April, no budgets", "October, so far". Exactly $0 is under, as MonthEnd says.
 */
export function monthResultWords(
	label: string,
	result: number | null,
	current: boolean,
): string {
	if (current) return `${label}, so far`;
	if (result === null) return `${label}, no budgets`;
	const amount = wholeUnlessTiny(Math.abs(result));
	return `${label}, ended ${amount} ${result < 0 ? "over" : "under"}`;
}

/**
 * The months the strip shows (spec §8.4): up to 36, containing the viewed month, starting at the first month with
 * history and extending later when history allows; older windows end at the viewed month. Its first and last months
 * are the window's ends, which Earlier and Later step past.
 */
function stripWindow(month: string, firstMonth: string, currentMonth: string) {
	const first =
		firstMonth > monthsBefore(month, 35) ? firstMonth : monthsBefore(month, 35);
	const last =
		currentMonth < monthsBefore(first, -35)
			? currentMonth
			: monthsBefore(first, -35);
	const count =
		(Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
		Number(last.slice(5, 7)) -
		Number(first.slice(5, 7));
	const months = Array.from(
		{ length: Math.min(36, Math.max(0, count) + 1) },
		(_, index) => monthsBefore(last, count - index),
	);
	return { first, last, months };
}

/** The months the strip links to, in order, for a viewed month: the same window MonthNavigation draws. */
export function stripMonths(
	month: string,
	firstMonth: string,
	currentMonth: string,
): string[] {
	return stripWindow(month, firstMonth, currentMonth).months;
}

/**
 * A strip month's dot (P133 A, as drawn): every dot is a bordered disc. A finished month holds its mark in it, the shown
 * month keeps an ink ring around that, and the current month, still going, keeps its accent ring with a small plain dot
 * in place of a result mark. The mark carries its status in its shape, and the link's words say it too, so the dot is
 * never colour alone.
 */
export function MonthDot({ mark, shown }: { mark: MonthMark; shown: boolean }) {
	const ring =
		mark === "current"
			? "ring-2 ring-accent ring-offset-2 ring-offset-paper"
			: shown
				? "ring-2 ring-ink ring-offset-2 ring-offset-paper"
				: "";
	return (
		<span
			aria-hidden="true"
			data-mark={mark}
			class={[
				"flex size-8 rounded-full items-center justify-center border border-rule",
				ring,
			]
				.filter(Boolean)
				.join(" ")}
		>
			{mark === "under" && (
				<span class="text-ok">
					<Icon name="check" class="size-4" />
				</span>
			)}
			{mark === "over" && (
				<svg aria-hidden="true" viewBox="0 0 16 16" class="size-4 text-over">
					<path
						d="M3 8h10"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
					/>
				</svg>
			)}
			{mark === "empty" && (
				<span class="size-3 rounded-full border-2 border-muted" />
			)}
			{mark === "current" && <span class="size-2 rounded-full bg-muted/45" />}
		</span>
	);
}

/** No-JavaScript links across the household's counted transaction months. */
export function MonthNavigation({
	month,
	firstMonth,
	currentMonth,
	results,
}: {
	month: string;
	firstMonth: string;
	currentMonth: string;
	/** Each finished month's result, as MonthEnd shows it (monthResults); null for a month with no budget. */
	results: Record<string, number | null>;
}) {
	const strip = stripWindow(month, firstMonth, currentMonth);
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
					{strip.months.map((item) => {
						const current = item === currentMonth;
						const selected = item === month;
						const label = monthLabel(item, currentMonth);
						const mark = monthMark(results[item] ?? null, current);
						return (
							<li>
								<a
									href={`/?month=${item}`}
									aria-current={selected ? "page" : undefined}
									class="flex min-h-11 w-11 flex-col items-center gap-0.5 text-sm text-muted no-underline"
								>
									<MonthDot mark={mark} shown={selected} />
									<span aria-hidden="true">{monthName(item).slice(0, 3)}</span>
									<span class="sr-only">
										{monthResultWords(label, results[item] ?? null, current)}
									</span>
								</a>
							</li>
						);
					})}
				</ol>
			</nav>
			{firstMonth < strip.first && (
				<a
					href={`/?month=${monthsBefore(strip.first, 1)}`}
					class="mt-1 inline-flex min-h-11 items-center text-sm text-muted no-underline"
				>
					Earlier
				</a>
			)}
			{strip.last < currentMonth && (
				<a
					href={`/?month=${monthsBefore(strip.last, -1)}`}
					class="mt-1 inline-flex min-h-11 items-center text-sm text-muted no-underline"
				>
					Later
				</a>
			)}
		</div>
	);
}
