// P6 (owner, 2026-09-26): nudge buttons on Home's budget rows, so a budget can be adjusted where
// it's seen, as Mint did. A static prototype for the proposals page; the buttons do nothing here.
// Every option uses decision 46's thin bar with no limit marker.
import { formatCents } from "../money";
import { barGeometry } from "../views/bar";
import { CategoryIcon } from "../views/category";
import { Icon } from "../views/icons";
import { ProgressRow } from "../views/progress-row";

type Row = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};

export const NUDGE_ROWS: Row[] = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 41200,
		budgetCents: 71200,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		spentCents: 28600,
		budgetCents: 25000,
	},
];

/** The next round $10 up or down: $712 → $720 or $710; $720 → $730 or $710. */
export function nudgedTo(cents: number, direction: 1 | -1): number {
	const step = 1000;
	const next =
		direction === 1
			? Math.floor(cents / step) * step + step
			: Math.ceil(cents / step) * step - step;
	return Math.max(0, next);
}

export const NUDGE_OPTIONS = [
	{
		key: "a",
		title: "Option A · Buttons at the row's ends",
		sentence:
			"A − before the icon and a + after the amount, on every row. Each tap saves, and the toast offers Undo. Tapping the rest of the row still opens the budget sheet to type an exact amount.",
	},
	{
		key: "b",
		title: "Option B · Buttons around the budget",
		sentence:
			"The − and + sit either side of the budget amount itself, so it's clear which number they change. Each tap saves, with Undo in the toast.",
	},
	{
		key: "c",
		title: "Option C · An Adjust mode",
		sentence:
			"Rows look as they do today. An Adjust button above the list shows the buttons on every row, and Done hides them. Fewer buttons on screen day to day, one tap more to start.",
	},
] as const;

type Option = (typeof NUDGE_OPTIONS)[number]["key"];

const whole = (c: number) => formatCents(c, { wholeDollars: true });

const round =
	"flex size-11 shrink-0 items-center justify-center rounded-full border border-rule text-xl leading-none text-muted";

/** A round nudge button, drawn but inert: this is a picture of the proposal. */
function Nudge({ sign }: { sign: "−" | "+" }) {
	return (
		<span class={round} aria-hidden="true">
			{sign}
		</span>
	);
}

function ThinBar({ row }: { row: Row }) {
	const over = row.spentCents > row.budgetCents;
	const { fillPct } = barGeometry(row.spentCents, row.budgetCents);
	return (
		<svg class="mt-2 h-1 w-full" aria-hidden="true">
			<rect width="100%" height="100%" rx="2" class="fill-rule" />
			<rect
				width={`${over ? 100 : fillPct}%`}
				height="100%"
				rx="2"
				class={over ? "fill-over" : "fill-ok"}
			/>
		</svg>
	);
}

function Over({ row }: { row: Row }) {
	if (row.spentCents <= row.budgetCents) return null;
	return (
		<p class="mt-1 flex items-center justify-end gap-1 text-over">
			<Icon name="alert" class="size-5" />
			{whole(row.spentCents - row.budgetCents)} over
		</p>
	);
}

function NudgeRow({
	row,
	option,
	adjusting,
}: {
	row: Row;
	option: Option;
	adjusting: boolean;
}) {
	const amounts = (
		<span class="text-lg">
			{whole(row.spentCents)} of {whole(row.budgetCents)}
		</span>
	);
	if (option === "b")
		return (
			<li class="flex items-start gap-4 py-3">
				<CategoryIcon icon={row.icon} color={row.color} />
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
						<span class="min-w-0 text-lg">{row.name}</span>
						<span class="flex flex-wrap items-center justify-end gap-2 text-lg">
							{whole(row.spentCents)} of
							<Nudge sign="−" />
							{whole(row.budgetCents)}
							<Nudge sign="+" />
						</span>
					</div>
					<ThinBar row={row} />
					<Over row={row} />
				</div>
			</li>
		);
	const withButtons = option === "a" || adjusting;
	return (
		<li class="flex items-center gap-3 py-3">
			{withButtons && <Nudge sign="−" />}
			<CategoryIcon icon={row.icon} color={row.color} />
			<div class="min-w-0 flex-1">
				<div class="flex items-baseline justify-between gap-3">
					<span class="text-lg">{row.name}</span>
					{amounts}
				</div>
				<ThinBar row={row} />
				<Over row={row} />
			</div>
			{withButtons && <Nudge sign="+" />}
		</li>
	);
}

function List({
	option,
	adjusting = false,
}: {
	option: Option;
	adjusting?: boolean;
}) {
	return (
		<ul class="divide-y divide-rule">
			{NUDGE_ROWS.map((row) => (
				<NudgeRow row={row} option={option} adjusting={adjusting} />
			))}
		</ul>
	);
}

/** The whole P6 comparison: three options, each at Home's list width. */
export function NudgeOptions() {
	const up = whole(nudgedTo(71200, 1));
	const down = whole(nudgedTo(71200, -1));
	return (
		<div class="flex flex-col gap-10">
			<p class="max-w-prose text-muted">
				Each tap moves the budget to the next round $10: Groceries' $712 becomes{" "}
				{up} with + or {down} with −. The toast says the new amount and offers
				Undo, and the change is announced. The step size is open too: $10 is
				shown.
			</p>
			<div class="flex min-w-0 max-w-2xl flex-col gap-2">
				<p class="text-sm font-semibold uppercase tracking-wide text-muted">
					Today
				</p>
				<p class="text-sm text-muted">
					Home's real rows as they are now: tap a row to open its budget sheet
					and type an amount. (Its 8px bar and limit line are already set to
					change: decision 46.)
				</p>
				<ul class="divide-y divide-rule">
					{NUDGE_ROWS.map((row) => (
						<ProgressRow {...row} />
					))}
				</ul>
			</div>
			{NUDGE_OPTIONS.map((opt) => (
				<div class="flex min-w-0 max-w-2xl flex-col gap-2">
					<p class="text-sm font-semibold uppercase tracking-wide text-muted">
						{opt.title}
					</p>
					<p class="text-sm text-muted">{opt.sentence}</p>
					{opt.key === "c" ? (
						<>
							<p class="mt-2 text-sm font-medium text-muted">Day to day</p>
							<div class="flex items-center justify-between">
								<span class="font-serif text-3xl font-semibold">Budget</span>
								<span class="inline-flex min-h-11 items-center text-accent">
									Adjust
								</span>
							</div>
							<List option="c" />
							<p class="mt-4 text-sm font-medium text-muted">
								After tapping Adjust
							</p>
							<div class="flex items-center justify-between">
								<span class="font-serif text-3xl font-semibold">Budget</span>
								<span class="inline-flex min-h-11 items-center text-accent">
									Done
								</span>
							</div>
							<List option="c" adjusting />
						</>
					) : (
						<List option={opt.key} />
					)}
				</div>
			))}
		</div>
	);
}
