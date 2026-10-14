import type { CategorySummary } from "../budget";
import { formatCents } from "../money";
import { endBarRatio } from "./bar";
import { CategoryIcon } from "./category";
import { categoryRowAmount, REFUND_WORDS } from "./category-amount";
import { headlineAmountClass } from "./headline-amount";

const wholeUnlessTiny = (cents: number) =>
	formatCents(cents, {
		wholeDollars: cents === 0 || Math.abs(cents) >= 100,
	});
const SHORT_NAMES: Record<string, string> = {
	Groceries: "Groc.",
	"Eating Out": "Eating",
	Gas: "Gas",
	Kids: "Kids",
	Household: "Home",
	Utilities: "Util.",
	Clothing: "Cloth.",
	Gifts: "Gifts",
	Pets: "Pets",
};
/** Short labels for a finished-month chart, disambiguated by the full category set. */
export function monthEndLabels(names: string[]): string[] {
	const normalized = names.map((name) =>
		name.normalize("NFC").trim().replace(/\s+/g, " "),
	);
	const words = normalized.map((name) => name.split(/\s+/));
	const extra = names.map(() => 0);
	const fullSpecial = names.map(() => false);
	const labelAt = (index: number) => {
		const name = normalized[index] ?? "";
		const parts = words[index] ?? [name];
		const first = Array.from(parts[0] ?? "");
		const count = Math.min(
			first.length,
			6 + (parts.length === 1 ? (extra[index] ?? 0) : 0),
		);
		const base = `${first.slice(0, count).join("")}${count < first.length ? "." : ""}`;
		if (fullSpecial[index]) return name;
		if ((extra[index] ?? 0) === 0)
			return Object.hasOwn(SHORT_NAMES, name)
				? (SHORT_NAMES[name] ?? base)
				: base;
		if (parts.length === 1) return base || name;
		let remaining = extra[index] ?? 0;
		const suffix = parts.slice(1).flatMap((part) => {
			if (remaining <= 0) return [];
			const chars = Array.from(part);
			const shown = chars.slice(0, remaining);
			remaining -= shown.length;
			return [`${shown.join("")}${shown.length < chars.length ? "." : ""}`];
		});
		return [base, ...suffix].filter(Boolean).join(" ") || name;
	};
	for (let pass = 0; pass <= names.length * 2; pass++) {
		const groups = new Map<string, number[]>();
		for (let index = 0; index < names.length; index++) {
			const label = labelAt(index);
			groups.set(label, [...(groups.get(label) ?? []), index]);
		}
		const duplicates = [...groups.values()].filter((group) => group.length > 1);
		if (!duplicates.length)
			return uniqueLabels(names.map((_, index) => labelAt(index)));
		for (const group of duplicates) {
			for (const index of group) {
				if (Object.hasOwn(SHORT_NAMES, normalized[index] ?? ""))
					fullSpecial[index] = true;
				else extra[index] = (extra[index] ?? 0) + 1;
			}
		}
	}
	return uniqueLabels(names.map((name, index) => normalized[index] || name));
}

function uniqueLabels(labels: string[]): string[] {
	const used = new Set<string>();
	return labels.map((label) => {
		const base = label.normalize("NFC").trim();
		let result = base;
		for (let suffix = 2; used.has(result); suffix++)
			result = `${base} ${suffix}`;
		used.add(result);
		return result;
	});
}

// At text-sm, 8 SVG units per Unicode code point is a conservative width estimate.
const labelNeedsCap = (text: string, cap = 62) =>
	Array.from(text).length * 8 > cap;
// Home's lg:max-w-2xl column is 672px; the wide copy of a ten-category chart stays within #300's 667px.
const WIDE_COPY_MAX = 667;
// The wide copy's room after its last bar: 6 units, then the budget word at the same estimate.
const BUDGET_WORD_ROOM = 6 + Array.from("budget").length * 8;

function EndBars({
	rows,
	chartId,
}: {
	rows: CategorySummary[];
	chartId: string;
}) {
	const scrolls = rows.length > 5;
	const scrollsAtLg = rows.length > 10;
	const phoneOnlyCue = scrolls && !scrollsAtLg;
	const left = scrolls ? 31 : 4;
	const areaRight = 292;
	const unit = 72;
	const barWidth = 42;
	const labels = monthEndLabels(rows.map((row) => row.name));
	const step =
		rows.length > 1 && !scrolls
			? Math.min(66, (areaRight - left - barWidth) / (rows.length - 1))
			: 66;
	// The wide copy of six to ten categories tightens its spacing so it fits WIDE_COPY_MAX with the budget word.
	const wideStep = Math.min(
		66,
		(WIDE_COPY_MAX - left - barWidth - BUDGET_WORD_ROOM) / (rows.length - 1),
	);
	const x0 = !scrolls
		? left + (areaRight - left - ((rows.length - 1) * step + barWidth)) / 2
		: left;
	const names = rows
		.map(
			(row) =>
				`${row.name} ${wholeUnlessTiny(row.spentCents)} of ${wholeUnlessTiny(row.budgetCents)}`,
		)
		.join(", ");
	// The 44px of trailing space is the phone cue's room. Only a copy where the cue shows reserves it.
	const chart = (cueSpace: boolean) => {
		// The wide copy has no cue: it ends at its last bar and keeps only the budget word's room.
		const wide = scrolls && !cueSpace;
		const barStep = wide ? wideStep : step;
		const lastBarEnd = x0 + Math.max(0, rows.length - 1) * barStep + barWidth;
		const width = wide
			? lastBarEnd + BUDGET_WORD_ROOM
			: Math.max(
					350,
					left + Math.max(0, rows.length - 1) * 66 + 42 + (cueSpace ? 44 : 0),
				);
		const lineEnd = wide ? lastBarEnd : scrolls ? width : areaRight;
		const wordX = wide ? lastBarEnd + 6 : scrolls ? width - 4 : areaRight + 6;
		const labelCap = wide ? Math.min(62, barStep - 4) : 62;
		return (
			<svg
				viewBox={`0 0 ${width} 142`}
				width={scrolls ? width : undefined}
				class={scrolls ? "block max-w-none" : "block w-full"}
				role="img"
				aria-label={`Spent against each budget: ${names || "no budgeted categories"}`}
			>
				<line
					x1={left}
					x2={lineEnd}
					y1="40"
					y2="40"
					class="stroke-muted"
					stroke-width="1"
					stroke-dasharray="4 4"
				/>
				<text
					x={wordX}
					y="45"
					text-anchor={scrolls && !wide ? "end" : undefined}
					class="fill-muted text-sm"
				>
					budget
				</text>
				{rows.map((row, index) => {
					const base = 112;
					const over = row.spentCents > row.budgetCents;
					const height = Math.max(
						3,
						Math.round(
							endBarRatio(row.spentCents, row.budgetCents).ratio * unit,
						),
					);
					const x = x0 + index * barStep;
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
									aria-label={`Over budget by ${wholeUnlessTiny(row.spentCents - row.budgetCents)}`}
									{...(labelNeedsCap(
										`+${wholeUnlessTiny(row.spentCents - row.budgetCents)}`,
										labelCap,
									)
										? { textLength: labelCap, lengthAdjust: "spacingAndGlyphs" }
										: {})}
								>
									<title>
										+{wholeUnlessTiny(row.spentCents - row.budgetCents)}
									</title>
									+{wholeUnlessTiny(row.spentCents - row.budgetCents)}
								</text>
							)}
							<text
								x={x + barWidth / 2}
								y={base + 20}
								text-anchor="middle"
								class="fill-muted text-sm"
								aria-label={row.name}
								{...(labelNeedsCap(labels[index] ?? "", labelCap)
									? { textLength: labelCap, lengthAdjust: "spacingAndGlyphs" }
									: {})}
							>
								<title>{row.name}</title>
								{labels[index]}
							</text>
						</g>
					);
				})}
			</svg>
		);
	};
	if (!scrolls) return <div class="mt-4">{chart(false)}</div>;
	return (
		<div class="relative mt-4">
			{/* biome-ignore lint/a11y/useSemanticElements: this scroll container must expose role=region explicitly */}
			<div
				role="region"
				tabindex={0}
				aria-label={`${rows.length} categories; scroll sideways to see them all`}
				class={
					phoneOnlyCue
						? "max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:hidden"
						: "max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				}
			>
				<div class="flex w-max">
					{chart(scrolls)}
					<span class="month-end-chart-tail" aria-hidden="true" />
					<span
						id={`${chartId}-chart-end`}
						class="w-px shrink-0"
						aria-hidden="true"
					/>
				</div>
			</div>
			<span
				class={
					phoneOnlyCue
						? "month-end-budget-label lg:hidden"
						: "month-end-budget-label"
				}
				aria-hidden="true"
			>
				budget
			</span>
			<span
				class={
					phoneOnlyCue
						? "month-end-chart-fade lg:hidden"
						: "month-end-chart-fade"
				}
				aria-hidden="true"
			/>
			<a
				href={`#${chartId}-chart-end`}
				aria-label="Show the rest of the categories"
				class={
					phoneOnlyCue
						? "month-end-chart-more inline-flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:hidden"
						: "month-end-chart-more inline-flex items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				}
			>
				<span
					class={
						phoneOnlyCue
							? "month-end-chart-more-icon month-end-swipe-arrow inline-flex size-[34px] items-center justify-center rounded-full bg-ink text-lg text-paper shadow-swipe-cue lg:hidden"
							: "month-end-chart-more-icon month-end-swipe-arrow inline-flex size-[34px] items-center justify-center rounded-full bg-ink text-lg text-paper shadow-swipe-cue"
					}
					aria-hidden="true"
				>
					→
				</span>
				<span class="sr-only">Show the rest of the categories</span>
			</a>
			<p
				class={
					phoneOnlyCue
						? "mt-1 flex items-center justify-center gap-2 text-sm text-muted lg:hidden"
						: "mt-1 flex items-center justify-center gap-2 text-sm text-muted"
				}
			>
				<span
					class={
						phoneOnlyCue
							? "month-end-swipe-arrow month-end-swipe-arrow-left text-accent lg:hidden"
							: "month-end-swipe-arrow month-end-swipe-arrow-left text-accent"
					}
					aria-hidden="true"
				>
					←
				</span>
				swipe sideways for the rest
				<span
					class={
						phoneOnlyCue
							? "month-end-swipe-arrow text-accent lg:hidden"
							: "month-end-swipe-arrow text-accent"
					}
					aria-hidden="true"
				>
					→
				</span>
			</p>
			{phoneOnlyCue && (
				<div class="mt-4 hidden lg:block">{chart(scrollsAtLg)}</div>
			)}
		</div>
	);
}

/** A finished month's net budget result and its category bars. */
export function MonthEnd({
	chartId,
	monthName,
	amountCents,
	rows,
}: {
	chartId: string;
	monthName: string;
	amountCents: number;
	rows: CategorySummary[];
}) {
	// With no budgeted category there is no budget result to stamp: no Over, and no Under either (#519).
	const budgeted = rows.length > 0;
	const over = budgeted && amountCents < 0;
	const amount = wholeUnlessTiny(Math.abs(amountCents));
	return (
		<section aria-label={`${monthName} ended`}>
			<p class="mt-4 text-lg text-muted">{monthName} ended</p>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				<p
					class={`whitespace-nowrap font-serif text-6xl font-semibold tracking-tight ${over ? "text-over" : ""} ${headlineAmountClass(amount)}`}
				>
					{amount}
				</p>
				{budgeted && (
					<span
						class={`inline-block -rotate-3 rounded-control border-2 px-3 py-0.5 text-xl font-extrabold tracking-widest uppercase ${over ? "border-over text-over" : "border-ok text-ok"}`}
					>
						{over ? "Over" : "Under"}
						<span class="sr-only"> budget</span>
					</span>
				)}
			</div>
			<EndBars rows={rows} chartId={chartId} />
		</section>
	);
}

/** A finished month's unbudgeted spending is information, without a budget action. */
export function PastNotBudgeted({
	items,
	needsCategory,
}: {
	items: { name: string; icon: string; color: string; spentCents: number }[];
	/** The month's uncategorized money, named once as the list's last row (#310). */
	needsCategory?: { spentCents: number; count: number };
}) {
	// Shown when the result includes uncategorized money: a non-zero amount, or transactions that net to $0.
	const needs =
		needsCategory && (needsCategory.count > 0 || needsCategory.spentCents !== 0)
			? needsCategory
			: undefined;
	if (items.length === 0 && !needs) return null;
	return (
		<>
			<h3 class="mt-6 text-sm text-muted">Not budgeted</h3>
			<ul class="divide-y divide-rule">
				{items.map((item) => (
					<li class="flex min-h-11 items-center gap-4 py-2">
						<CategoryIcon icon={item.icon} color={item.color} />
						<span class="min-w-0 flex-1 truncate text-lg">{item.name}</span>
						<span class={categoryRowAmount(item.spentCents).className}>
							{categoryRowAmount(item.spentCents).text}
							{item.spentCents < 0 && (
								<span class="sr-only">{REFUND_WORDS}</span>
							)}
						</span>
					</li>
				))}
				{needs && (
					<li class="flex min-h-11 items-center gap-4 py-2">
						<CategoryIcon icon="list" color="" />
						<span class="min-w-0 flex-1 truncate text-lg">
							Needs a category
						</span>
						<span class={categoryRowAmount(needs.spentCents).className}>
							{categoryRowAmount(needs.spentCents).text}
							{needs.spentCents < 0 && (
								<span class="sr-only">{REFUND_WORDS}</span>
							)}
						</span>
					</li>
				)}
			</ul>
		</>
	);
}
