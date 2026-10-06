// The parts of the Trends page (spec §8.3, picked on the proposals page: P23 D, P24 A, P31, P33 A).
// Bars are inline SVG in tokens only: the CSP forbids style attributes, and every chart carries its
// numbers in words for a screen reader.
import type { Child } from "hono/jsx";
import {
	type Direction,
	MONTH_BARS,
	type MonthPoint,
	miniBars,
	monthBars,
	type TrendsPage,
	trendsAmount,
} from "../trends";
import { CategoryIcon } from "./category";
import { EmptyState } from "./empty-state";
import { HowLink } from "./how-link";
import { Icon } from "./icons";
import { WhyLink } from "./why-link";

/**
 * What's spent so far this month as the serif number, and the sentence comparing it with the same
 * days last month, with a Why? to the rule behind it. The sentence is left out when there's no
 * full month to compare with.
 */
export function TrendsTop({
	month,
	spent,
	sentence,
}: {
	/** "October" */
	month: string;
	/** "$1,240" */
	spent: string;
	/** "$90 less than by this time in September." */
	sentence?: string;
}) {
	return (
		<>
			<p class="text-lg text-muted">Spent so far in {month}</p>
			<p class="font-serif text-6xl font-semibold tracking-tight lg:text-7xl">
				{spent}
			</p>
			{sentence && (
				<p class="mt-1 flex flex-wrap items-center gap-x-2 font-serif text-lg italic">
					{sentence}
					<span class="font-sans not-italic">
						<WhyLink section="trends" topic="this month against last" />
					</span>
				</p>
			)}
		</>
	);
}

/** A small muted heading over a ruled list, with an optional icon (a word and an icon, never color alone) and Why?. */
export function TrendGroup({
	id,
	title,
	icon,
	tone = "text-ink",
	why,
	children,
}: {
	id: string;
	title: string;
	icon?: "check" | "arrow-up";
	/** The icon's color token class: "text-ok" for good news, "text-ink" for what to watch. */
	tone?: "text-ok" | "text-ink";
	/** What the Why? link is about ("going well"); none, no link. */
	why?: string;
	children?: Child;
}) {
	return (
		<section aria-labelledby={`${id}-title`}>
			<div
				class={`${why ? "mt-3" : "mt-5"} flex items-center gap-2 text-sm text-muted`}
			>
				<h2 id={`${id}-title`} class="flex items-center gap-2">
					{icon && (
						<span class={tone}>
							<Icon name={icon} class="size-4" />
						</span>
					)}
					{title}
				</h2>
				{why && (
					<>
						<span aria-hidden="true">·</span>
						<WhyLink section="trends" topic={why} />
					</>
				)}
			</div>
			<ul class="divide-y divide-rule border-y border-rule">{children}</ul>
		</section>
	);
}

/**
 * Six small bars, one per month, ink on a ledger rule, scaled to the row's tallest month. The last
 * is the month still going: an outline with a dashed edge. A short history sits at the right.
 */
export function MiniBars({
	months,
	label,
}: {
	months: MonthPoint[];
	/** The six amounts in words: the chart's text alternative. */
	label: string;
}) {
	const bars = miniBars(months.map((m) => m.cents));
	return (
		<svg
			viewBox="0 0 96 32"
			role="img"
			aria-label={label}
			class="h-8 w-24 shrink-0"
		>
			<line x1="0" x2="96" y1="31.5" y2="31.5" class="stroke-rule" />
			{bars.map((b) => (
				<rect
					x={b.x}
					y={b.y}
					width={b.width}
					height={b.height}
					class={b.dashed ? "fill-paper stroke-ink" : "fill-ink"}
					stroke-dasharray={b.dashed ? "2 2" : undefined}
				/>
			))}
		</svg>
	);
}

/** One category: its icon, name, a line of words ("4 months under budget") and its six small bars. */
export function TrendRow({
	name,
	icon,
	color,
	line,
	note,
	months,
	label,
}: {
	name: string;
	icon: string;
	color: string;
	line: string;
	/** A muted second line under the first: "Still under budget" under a Worth a look row. */
	note?: string | null;
	months: MonthPoint[];
	label: string;
}) {
	return (
		<li class="flex min-h-16 items-center gap-4 py-2">
			<CategoryIcon icon={icon} color={color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{name}</span>
				<span class="block leading-6 text-muted">{line}</span>
				{note && <span class="block leading-6 text-muted">{note}</span>}
			</span>
			<MiniBars months={months} label={label} />
		</li>
	);
}

/**
 * One category's change since the same days last month, in words with an arrow ("Up $31"). More
 * spending isn't a status, so it stays ink; the words carry it, never color.
 */
export function ChangeRow({
	name,
	icon,
	color,
	detail,
	direction,
	words,
}: {
	name: string;
	icon: string;
	color: string;
	/** "$92, was $61" */
	detail: string;
	direction: Direction;
	words: string;
}) {
	return (
		<li class="flex min-h-16 items-center gap-4 py-2">
			<CategoryIcon icon={icon} color={color} />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{name}</span>
				<span class="block leading-6 text-muted">{detail}</span>
			</span>
			<span class="flex shrink-0 items-center gap-1 text-lg">
				{direction !== "same" && (
					<Icon
						name={direction === "up" ? "arrow-up" : "arrow-down"}
						class="size-4"
					/>
				)}
				{words}
			</span>
		</li>
	);
}

/**
 * All spending by month as bars on ledger rules, each month's amount above it: Trends' early
 * state, before there's a full month to compare. The month still going is dashed and says "so far".
 * The first month of history may be only part of a month, so its bar is striped (diagonal ink
 * stripes on paper) and its text alternative says it's a part month.
 */
export function MonthBars({
	id = "month-bars",
	months,
	label,
}: {
	/** Names the stripe pattern; two charts on one page need two ids. */
	id?: string;
	months: MonthPoint[];
	label: string;
}) {
	const { width, height, top, bottom, rules } = MONTH_BARS;
	const bars = monthBars(months);
	const stripes = `${id}-part`;
	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			role="img"
			aria-label={label}
			class="w-full max-w-lg"
		>
			{bars.some((b) => b.part) && (
				<defs>
					<pattern
						id={stripes}
						width="5"
						height="5"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<rect width="5" height="5" class="fill-paper" />
						<rect width="2.5" height="5" class="fill-ink" />
					</pattern>
				</defs>
			)}
			{Array.from({ length: rules }, (_, i) => {
				const y = Number((top + ((bottom - top) / (rules - 1)) * i).toFixed(1));
				return <line x1="0" x2={width} y1={y} y2={y} class="stroke-rule" />;
			})}
			{bars.map((b) => {
				const centre = Number((b.x + b.width / 2).toFixed(1));
				return (
					<>
						<rect
							x={b.x}
							y={b.y}
							width={b.width}
							height={b.height}
							fill={b.part ? `url(#${stripes})` : undefined}
							class={
								b.part
									? "stroke-ink"
									: b.dashed
										? "fill-paper stroke-ink"
										: "fill-ink"
							}
							stroke-dasharray={b.dashed ? "3 3" : undefined}
						/>
						<text
							x={centre}
							y={b.y - 6}
							text-anchor="middle"
							font-size="11"
							class="fill-muted"
						>
							{b.amount}
						</text>
						<text
							x={centre}
							y={height - 6}
							text-anchor="middle"
							font-size="12"
							class={b.dashed ? "fill-ink" : "fill-muted"}
						>
							{b.label}
						</text>
					</>
				);
			})}
		</svg>
	);
}

/**
 * The Trends page's content (spec §8.3): this month so far against the same days last month, each
 * category's change, then Going well, Worth a look and every other category with six small bars.
 * Before there's a full month to compare it shows all spending by month and when Tally started (P31).
 */
export function TrendsScreen({
	page,
	id = "trends",
}: {
	page: TrendsPage;
	/** Names the early state's stripe pattern; two pages in one document (the catalog) need two ids. */
	id?: string;
}) {
	return (
		<div class="lg:max-w-2xl">
			<h1 class="font-serif text-5xl font-semibold tracking-tight">Trends</h1>
			<HowLink section="trends" />
			{page.kind === "empty" && (
				<EmptyState
					kind="add"
					sentence="No spending to show yet."
					hint="Trends fill in as your transactions arrive."
					action={{ href: "/accounts", label: "Open Accounts" }}
				/>
			)}
			{page.kind === "early" && (
				<>
					{/* This month so far, with no sentence: last month is only part of a month, or there is none. */}
					<TrendsTop
						month={page.monthName}
						spent={trendsAmount(page.soFarCents)}
					/>
					<h2 class="mt-4 text-lg">All spending</h2>
					<MonthBars
						id={`${id}-bars`}
						months={page.months}
						label={page.label}
					/>
					<p class="mt-2 text-muted">
						Trends fill in as months pass. Tally started in{" "}
						{page.startMonthName}.
					</p>
				</>
			)}
			{page.kind === "full" && (
				<>
					<TrendsTop
						month={page.monthName}
						spent={trendsAmount(page.soFarCents)}
						sentence={page.sentence}
					/>
					{page.changes.length > 0 && (
						<TrendGroup id="changes" title={page.caption}>
							{page.changes.map((change) => (
								<ChangeRow
									name={change.name}
									icon={change.icon}
									color={change.color}
									detail={change.detail}
									direction={change.direction}
									words={change.words}
								/>
							))}
						</TrendGroup>
					)}
					{page.goingWell.length > 0 && (
						<TrendGroup
							id="going-well"
							title="Going well"
							icon="check"
							tone="text-ok"
							why="going well"
						>
							{page.goingWell.map((row) => (
								<TrendRow
									name={row.name}
									icon={row.icon}
									color={row.color}
									line={row.line}
									note={row.note}
									months={row.months}
									label={row.label}
								/>
							))}
						</TrendGroup>
					)}
					{page.worthALook.length > 0 && (
						<TrendGroup
							id="worth-a-look"
							title="Worth a look"
							icon="arrow-up"
							tone="text-ink"
							why="worth a look"
						>
							{page.worthALook.map((row) => (
								<TrendRow
									name={row.name}
									icon={row.icon}
									color={row.color}
									line={row.line}
									note={row.note}
									months={row.months}
									label={row.label}
								/>
							))}
						</TrendGroup>
					)}
					{page.others.length > 0 && (
						<TrendGroup
							id="others"
							title={`${page.goingWell.length + page.worthALook.length > 0 ? "Every other category" : "Every category"}, ${page.rangeLabel}`}
						>
							{page.others.map((row) => (
								<TrendRow
									name={row.name}
									icon={row.icon}
									color={row.color}
									line={row.line}
									note={row.note}
									months={row.months}
									label={row.label}
								/>
							))}
						</TrendGroup>
					)}
				</>
			)}
		</div>
	);
}
