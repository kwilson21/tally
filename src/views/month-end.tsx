import type { CategorySummary } from "../budget";
import { formatCents } from "../money";
import { endBarRatio } from "./bar";
import { CategoryIcon } from "./category";

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });
const SHORT_NAMES: Record<string, string> = {
	Groceries: "Groc.",
	"Eating Out": "Eating",
	Household: "Home",
	Utilities: "Util.",
	Clothing: "Cloth.",
};

function EndBars({ rows }: { rows: CategorySummary[] }) {
	const width = 360;
	const base = 98;
	const unit = 62;
	const barWidth = 32;
	const step = rows.length > 1 ? Math.min(64, 320 / (rows.length - 1)) : 64;
	const start = (width - ((rows.length - 1) * step + barWidth)) / 2;
	const names = rows
		.map(
			(row) =>
				`${row.name} ${whole(row.spentCents)} of ${whole(row.budgetCents)}`,
		)
		.join(", ");
	return (
		<svg
			viewBox={`0 0 ${width} 128`}
			class="mt-2 w-full"
			role="img"
			aria-label={`Spent against each budget: ${names || "no budgeted categories"}`}
		>
			<line
				x1="8"
				x2="318"
				y1={base - unit}
				y2={base - unit}
				class="stroke-muted"
				stroke-dasharray="4 4"
			/>
			<text x="324" y={base - unit + 5} class="fill-muted text-xs">
				budget
			</text>
			{rows.map((row, index) => {
				const over = row.spentCents > row.budgetCents;
				const ratio = endBarRatio(row.spentCents, row.budgetCents);
				const height = Math.max(3, Math.round(ratio.ratio * unit));
				const x = start + index * step;
				return (
					<g>
						<rect
							x={x}
							y={base - height}
							width={barWidth}
							height={height}
							rx="3"
							class={over ? "fill-over" : "fill-muted/60"}
						/>
						{over && (
							<text
								x={x + barWidth / 2}
								y={base - height - 5}
								text-anchor="middle"
								class="fill-over text-xs font-semibold"
							>
								+{whole(row.spentCents - row.budgetCents)}
							</text>
						)}
						<text
							x={x + barWidth / 2}
							y={base + 16}
							text-anchor="middle"
							class="fill-muted text-xs"
						>
							{SHORT_NAMES[row.name] ?? row.name.slice(0, 4)}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

/** A finished month's net budget result and its category bars. */
export function MonthEnd({
	monthName,
	amountCents,
	rows,
}: {
	monthName: string;
	amountCents: number;
	rows: CategorySummary[];
}) {
	const over = amountCents < 0;
	return (
		<section aria-label={`${monthName} ended`}>
			<p class="mt-4 text-lg text-muted">{monthName} ended</p>
			<div class="flex items-center gap-4">
				<p
					class={`whitespace-nowrap font-serif text-6xl font-semibold tracking-tight ${over ? "text-over" : ""}`}
				>
					{whole(Math.abs(amountCents))}
				</p>
				<span
					class={`inline-block -rotate-3 rounded-control border-2 px-3 py-0.5 text-xl font-extrabold tracking-widest uppercase ${over ? "border-over text-over" : "border-ok text-ok"}`}
				>
					{over ? "Over" : "Under"}
					<span class="sr-only"> budget</span>
				</span>
			</div>
			<EndBars rows={rows} />
		</section>
	);
}

/** A finished month's unbudgeted spending is information, without a budget action. */
export function PastNotBudgeted({
	items,
}: {
	items: { name: string; icon: string; color: string; spentCents: number }[];
}) {
	if (items.length === 0) return null;
	return (
		<>
			<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
			<ul class="divide-y divide-rule">
				{items.map((item) => (
					<li class="flex min-h-11 items-center gap-4 py-2">
						<CategoryIcon icon={item.icon} color={item.color} />
						<span class="min-w-0 flex-1 truncate text-lg">{item.name}</span>
						<span class="text-lg">
							{formatCents(item.spentCents, { wholeDollars: true })}
						</span>
					</li>
				))}
			</ul>
		</>
	);
}
