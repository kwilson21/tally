// The proposals page (#79): each undecided proposal next to its alternatives, so the owner decides
// by seeing, not reading (DESIGN.md). Prototypes live only here; an accepted one moves into the
// real component in its own PR, and a decided proposal leaves this page.
import { formatCents } from "../money";
import { barGeometry } from "../views/bar";
import { CategoryIcon } from "../views/category";
import { Icon } from "../views/icons";
import { Specimen } from "./specimen";

type Row = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};

// Under, a little over, and far over, so each option is seen at both ends.
export const LIMIT_ROWS: Row[] = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 41200,
		budgetCents: 70000,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		spentCents: 28600,
		budgetCents: 25000,
	},
	{
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		spentCents: 45000,
		budgetCents: 30000,
	},
];

export const LIMIT_OPTIONS = [
	{
		key: "a",
		title: "Option A · No marker",
		sentence:
			"Over budget, the bar is full and brick; the words say by how much. Nothing marks where the budget was.",
	},
	{
		key: "b",
		title: "Option B · Two tones",
		sentence:
			"Up to the budget the bar is pale brick; the part past it is solid brick, after a small gap at the budget.",
	},
	{
		key: "c",
		title: "Option C · A gap at the budget",
		sentence:
			"One solid brick bar, with a small gap where the budget ends. The gap is the only marker.",
	},
] as const;

type Option = (typeof LIMIT_OPTIONS)[number]["key"];

const whole = (c: number) => formatCents(c, { wholeDollars: true });

/** A 4px bar (the thinner bar, decision 46) with one of the three ways to show the budget. */
function ThinBar({ row, option }: { row: Row; option: Option }) {
	const over = row.spentCents > row.budgetCents;
	const { fillPct, limitPct } = barGeometry(row.spentCents, row.budgetCents);
	if (!over)
		return (
			<svg class="mt-2 h-1 w-full" aria-hidden="true">
				<rect width="100%" height="100%" rx="2" class="fill-rule" />
				<rect width={`${fillPct}%`} height="100%" rx="2" class="fill-ok" />
			</svg>
		);
	if (option === "a")
		return (
			<svg class="mt-2 h-1 w-full" aria-hidden="true">
				<rect width="100%" height="100%" rx="2" class="fill-over" />
			</svg>
		);
	// A gap of 1% of the track either side of the budget: enough to see, not enough to read as a line.
	const before = limitPct - 1;
	const after = limitPct + 1;
	return (
		<svg class="mt-2 h-1 w-full" aria-hidden="true">
			<rect
				width={`${before}%`}
				height="100%"
				rx="2"
				class={option === "b" ? "fill-over/35" : "fill-over"}
			/>
			<rect
				x={`${after}%`}
				width={`${100 - after}%`}
				height="100%"
				rx="2"
				class="fill-over"
			/>
		</svg>
	);
}

function LimitRow({ row, option }: { row: Row; option: Option }) {
	const over = row.spentCents > row.budgetCents;
	return (
		<li class="flex items-start gap-4 py-3">
			<CategoryIcon icon={row.icon} color={row.color} />
			<div class="min-w-0 flex-1">
				<div class="flex items-baseline justify-between gap-3">
					<span class="text-lg">{row.name}</span>
					<span class="text-lg">
						{whole(row.spentCents)} of {whole(row.budgetCents)}
					</span>
				</div>
				<ThinBar row={row} option={option} />
				{over && (
					<p class="mt-1 flex items-center justify-end gap-1 text-over">
						<Icon name="alert" class="size-5" />
						{whole(row.spentCents - row.budgetCents)} over
					</p>
				)}
			</div>
		</li>
	);
}

// What the owner decided on 2026-09-26 (decision 46), and the issue each ships in.
export const DECIDED = [
	{
		title: "P1 · The number on a phone's first screen",
		outcome:
			"Take it. Things to try moves off the first screen; onboarding becomes its own initiative.",
		issue: 92,
	},
	{ title: "P2 · Tidied bank names", outcome: "Take it.", issue: 93 },
	{
		title: "P3 · The money input's ±$1 buttons",
		outcome: "Keep today's round buttons.",
		issue: 80,
	},
	{
		title: "P4 · Thinner budget bars",
		outcome:
			"Take the 4px bar, without the black limit line. How to show the budget is P5, below.",
		issue: 86,
	},
] as const;

/** The proposals page body. */
export function Proposals() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Proposals
			</h1>
			<p class="mt-3 max-w-prose text-lg">
				Each open proposal next to its alternatives. Nothing here is decided
				until you pick. Look at it on your phone as well as a wide screen.
			</p>
			<p class="mt-2">
				<a href="/design-system" class="inline-flex min-h-11 items-center">
					Back to the design system
				</a>
			</p>

			<section aria-labelledby="open-title" class="mt-10">
				<h2 id="open-title" class="font-serif text-3xl font-semibold">
					Open
				</h2>
				<Specimen
					id="p5"
					title="P5 · Showing the budget on a thin bar"
					tier="visual"
					sentence="Every option drops the black line and is shown at Home's list width. Under budget, the end of the bar is the budget, so nothing else is drawn. Each option is shown a little over and far over; the words and the alert icon stay, so over budget is never color alone."
				>
					<div class="flex flex-col gap-10">
						{LIMIT_OPTIONS.map((opt) => (
							<div class="flex min-w-0 max-w-2xl flex-col gap-2">
								<p class="text-sm font-semibold uppercase tracking-wide text-muted">
									{opt.title}
								</p>
								<p class="text-sm text-muted">{opt.sentence}</p>
								<ul class="divide-y divide-rule">
									{LIMIT_ROWS.map((row) => (
										<LimitRow row={row} option={opt.key} />
									))}
								</ul>
							</div>
						))}
					</div>
				</Specimen>
			</section>

			<section aria-labelledby="decided-title" class="mt-12">
				<h2 id="decided-title" class="font-serif text-3xl font-semibold">
					Decided
				</h2>
				<ul class="mt-3 divide-y divide-rule">
					{DECIDED.map((d) => (
						<li class="py-3">
							<p class="font-medium">{d.title}</p>
							<p class="text-muted">
								{d.outcome} Ships in{" "}
								<a
									href={`https://github.com/kwilson21/tally/issues/${d.issue}`}
									class="inline-flex min-h-11 items-center"
								>
									#{d.issue}
								</a>
								.
							</p>
						</li>
					))}
				</ul>
			</section>
		</>
	);
}
