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
	const width = 350;
	const left = 4;
	const areaRight = 292;
	const unit = 72;
	const barWidth = 42;
	const maxPerRow = 5;
	const panels = Array.from(
		{ length: Math.max(1, Math.ceil(rows.length / maxPerRow)) },
		(_, index) => rows.slice(index * maxPerRow, (index + 1) * maxPerRow),
	);
	const names = rows
		.map(
			(row) =>
				`${row.name} ${whole(row.spentCents)} of ${whole(row.budgetCents)}`,
		)
		.join(", ");
	return (
		<svg
			viewBox={`0 0 ${width} ${panels.length * 142}`}
			class="mt-4 w-full"
			role="img"
			aria-label={`Spent against each budget: ${names || "no budgeted categories"}`}
		>
			{panels.map((panel, rowIndex) => {
				const base = 112;
				const step =
					panel.length > 1
						? Math.min(66, (areaRight - left - barWidth) / (panel.length - 1))
						: 66;
				const start =
					left +
					(areaRight - left - ((panel.length - 1) * step + barWidth)) / 2;
				const lineY = base - unit;
				return (
					<g transform={`translate(0 ${rowIndex * 142})`}>
						<line
							x1={left}
							x2={areaRight}
							y1={lineY}
							y2={lineY}
							class="stroke-muted"
							stroke-width="1"
							stroke-dasharray="4 4"
						/>
						<text x={areaRight + 6} y={lineY + 5} class="fill-muted text-sm">
							budget
						</text>
						{panel.map((row, index) => {
							const over = row.spentCents > row.budgetCents;
							const height = Math.max(
								3,
								Math.round(
									endBarRatio(row.spentCents, row.budgetCents).ratio * unit,
								),
							);
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
											y={base - height - 6}
											text-anchor="middle"
											class="fill-over text-sm font-semibold"
										>
											+{whole(row.spentCents - row.budgetCents)}
										</text>
									)}
									<text
										x={x + barWidth / 2}
										y={base + 20}
										text-anchor="middle"
										class="fill-muted text-sm"
									>
										{SHORT_NAMES[row.name] ?? row.name.slice(0, 4)}
									</text>
								</g>
							);
						})}
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
