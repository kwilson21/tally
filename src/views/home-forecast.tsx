import { monthName } from "../dates";
import { formatCents } from "../money";
import { Icon } from "./icons";

/** A compact, screen-reader named forecast from the month's daily counted spending. */
export function HomeForecast({
	month,
	day,
	daysInMonth,
	spentByDay,
	budgetCents,
	endCents,
	differenceCents,
}: {
	month: string;
	day: number;
	daysInMonth: number;
	spentByDay: number[];
	budgetCents: number;
	endCents: number;
	differenceCents: number;
}) {
	const under = differenceCents >= 0;
	const shownCents = under
		? Math.floor(differenceCents / 100) * 100
		: Math.ceil(-differenceCents / 100) * 100;
	const whole = (cents: number) => formatCents(cents, { wholeDollars: true });
	const left = 10;
	const right = 340;
	const top = 34;
	const base = 142;
	let cumulativeCents = 0;
	let peakCents = 0;
	for (const cents of spentByDay.slice(0, day)) {
		cumulativeCents += cents;
		peakCents = Math.max(peakCents, cumulativeCents);
	}
	const ymax = Math.max(budgetCents, endCents, peakCents, 1);
	const x = (d: number) =>
		left + ((d - 1) / (daysInMonth - 1)) * (right - left);
	const y = (cents: number) => base - (cents / ymax) * (base - top);
	let running = 0;
	const actual = spentByDay
		.slice(0, day)
		.map((cents, index) => {
			running += cents;
			return `${x(index + 1).toFixed(1)},${y(running).toFixed(1)}`;
		})
		.join(" ");
	const monthLabel = monthName(month).slice(0, 3);
	return (
		<figure class="mt-3">
			<svg
				viewBox="0 0 350 172"
				class="w-full"
				role="img"
				aria-label={`Spending in ${monthLabel} so far, and where it ends at this pace: ${whole(shownCents)} ${under ? "under" : "over"} the ${whole(budgetCents)} budget by ${monthLabel} ${daysInMonth}`}
			>
				<line
					x1={left}
					x2={right}
					y1={y(budgetCents)}
					y2={y(budgetCents)}
					class="stroke-muted"
					stroke-width="1"
					stroke-dasharray="4 4"
				/>
				<text x={left} y={y(budgetCents) - 7} class="fill-muted text-sm">
					budget {whole(budgetCents)}
				</text>
				<polyline
					points={actual}
					fill="none"
					class="stroke-ink"
					stroke-width="2.5"
					stroke-linejoin="round"
					stroke-linecap="round"
				/>
				<line
					x1={x(day)}
					y1={y(running)}
					x2={x(daysInMonth)}
					y2={y(endCents)}
					class={under ? "stroke-ok" : "stroke-over"}
					stroke-width="2.5"
					stroke-dasharray="6 5"
					stroke-linecap="round"
				/>
				<circle cx={x(day)} cy={y(running)} r="4.5" class="fill-ink" />
				<circle
					cx={x(daysInMonth)}
					cy={y(endCents)}
					r="5.5"
					class={under ? "fill-ok" : "fill-over"}
				/>
				<text x={left} y="166" class="fill-muted text-sm">
					{monthLabel} 1
				</text>
				<text x={right} y="166" text-anchor="end" class="fill-muted text-sm">
					{monthLabel} {daysInMonth}
				</text>
			</svg>
			<figcaption class="mt-2 flex flex-wrap items-baseline gap-x-2">
				<span
					class={`inline-flex items-center gap-1.5 font-serif text-4xl font-semibold ${under ? "text-ok" : "text-over"}`}
				>
					{!under && <Icon name="alert" class="size-6" />}
					{whole(shownCents)} {under ? "under" : "over"}
				</span>
				<span class="text-lg text-muted">
					by {monthLabel} {daysInMonth}, at this pace
				</span>
			</figcaption>
		</figure>
	);
}
