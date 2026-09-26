// The diagrams on How Tally works (spec §9, #61): each feature's rule as a small picture, drawn by
// code from the same numbers as the section's worked example. Budget, Transactions and Categories
// are boxes and arrows like the system diagram; Excluding is one bar. Sized for a 390px phone.
import type { Child } from "hono/jsx";
import type { MonthSummary } from "../budget";
import type { ExcludedBreakdown } from "../how-it-works/examples";
import { excludedTotal } from "../how-it-works/examples";
import { formatCents } from "../money";

const W = 360;
const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** An accessible SVG: a role, a title and a description that say the same numbers in words. */
function Figure({
	id,
	title,
	desc,
	width = W,
	height,
	children,
}: {
	id: string;
	title: string;
	desc: string;
	width?: number;
	height: number;
	children?: Child;
}) {
	return (
		<svg
			class="h-auto w-full max-w-md"
			viewBox={`0 0 ${width} ${height}`}
			fill="none"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			role="img"
			aria-labelledby={`${id}-title ${id}-desc`}
		>
			<title id={`${id}-title`}>{title}</title>
			<desc id={`${id}-desc`}>{desc}</desc>
			{children}
		</svg>
	);
}

/** A down arrow at x from y1 to y2. */
const down = (x: number, y1: number, y2: number) =>
	`M${x} ${y1} V${y2} M${x - 6} ${y2 - 6} L${x} ${y2} L${x + 6} ${y2 - 6}`;

/** Budget − Spent (− Bills due) = Safe to spend, as boxes. */
export function BudgetDiagram(
	s: Pick<
		MonthSummary,
		"totalBudgetCents" | "totalSpentCents" | "safeToSpendCents"
	>,
) {
	// As in the worked example: what was set aside for bills is whatever makes the sum add up.
	const billsCents =
		s.totalBudgetCents - s.totalSpentCents - s.safeToSpendCents;
	const over = s.safeToSpendCents < 0;
	const boxes: [string, number][] = [
		["Budget", s.totalBudgetCents],
		["Spent", s.totalSpentCents],
		...(billsCents > 0 ? [["Bills due", billsCents] as [string, number]] : []),
		["Safe to spend", s.safeToSpendCents],
	];
	const width = boxes.length === 4 ? 440 : W;
	const gap = 22;
	const boxW = (width - 2 - gap * (boxes.length - 1)) / boxes.length;
	const money = (cents: number) => formatCents(cents);
	const bills =
		billsCents > 0 ? ` minus ${money(billsCents)} for bills due` : "";
	return (
		<Figure
			id="budget-diagram"
			title="How safe to spend is worked out"
			desc={`The ${money(s.totalBudgetCents)} budget minus ${money(s.totalSpentCents)} spent${bills} leaves ${money(s.safeToSpendCents)} safe to spend.`}
			width={width}
			height={68}
		>
			{boxes.map(([label, cents], i) => {
				const x = 1 + i * (boxW + gap);
				const last = i === boxes.length - 1;
				const cx = x + boxW / 2;
				return (
					<g>
						<rect
							x={x}
							y="4"
							width={boxW}
							height="60"
							rx="8"
							class={last ? (over ? "stroke-over" : "stroke-ok") : "stroke-ink"}
							stroke-width={last ? "2.5" : undefined}
						/>
						<text
							x={cx}
							y="28"
							font-size="13"
							text-anchor="middle"
							class={last ? (over ? "fill-over" : "fill-ok") : "fill-muted"}
						>
							{label}
						</text>
						<text
							x={cx}
							y="50"
							font-size="15"
							font-weight="600"
							text-anchor="middle"
							class="fill-ink"
						>
							{money(cents)}
						</text>
						{!last && (
							<text
								x={x + boxW + gap / 2}
								y="40"
								font-size="18"
								text-anchor="middle"
								class="fill-ink"
							>
								{i === boxes.length - 2 ? "=" : "−"}
							</text>
						)}
					</g>
				);
			})}
		</Figure>
	);
}

/** One step: a full-width box with its words on the left and its count on the right. */
function Step({
	y,
	label,
	count,
	dashed = false,
}: {
	y: number;
	label: Child;
	count: number;
	dashed?: boolean;
}) {
	return (
		<g>
			<rect
				x="1"
				y={y}
				width={W - 2}
				height="44"
				rx="8"
				class="stroke-ink"
				stroke-dasharray={dashed ? "5 4" : undefined}
			/>
			<text x="16" y={y + 27} font-size="15" class="fill-ink">
				{label}
			</text>
			<text
				x={W - 14}
				y={y + 27}
				font-size="15"
				font-weight="600"
				text-anchor="end"
				class="fill-ink"
			>
				{count}
			</text>
		</g>
	);
}

/** This month → (− excluded) → Counted → Needs a category, top to bottom. */
export function TransactionsDiagram(c: {
	counted: number;
	excluded: number;
	needsCategory: number;
}) {
	const total = c.counted + c.excluded;
	const needs =
		c.needsCategory === 0
			? "None need a category."
			: `${c.needsCategory} of those ${c.needsCategory === 1 ? "needs" : "need"} a category.`;
	const counts =
		c.excluded === 0
			? `${plural(total, "transaction", "transactions")} this month, and ${total === 1 ? "it counts" : "they all count"}.`
			: `${plural(total, "transaction", "transactions")} this month. ${c.excluded} ${c.excluded === 1 ? "is" : "are"} excluded, so ${c.counted} ${c.counted === 1 ? "counts" : "count"}.`;
	return (
		<Figure
			id="transactions-diagram"
			title="Which transactions count"
			desc={`${counts} ${needs}`}
			height={218}
		>
			<Step y={4} label="This month" count={total} />
			<path d={down(40, 48, 84)} class="stroke-ink" />
			{c.excluded > 0 && (
				<text x="56" y="71" font-size="13" class="fill-muted">
					− {c.excluded} excluded
				</text>
			)}
			<Step y={88} label="Counted" count={c.counted} />
			<path d={down(40, 132, 168)} class="stroke-ink" />
			<Step y={172} label="Needs a category" count={c.needsCategory} />
		</Figure>
	);
}

/** This month's transactions as one bar: the counted part solid, each kind of exclusion a dashed slice. */
export function ExclusionsDiagram({
	counted,
	breakdown,
}: {
	counted: number;
	breakdown: ExcludedBreakdown;
}) {
	const excluded = excludedTotal(breakdown);
	const total = counted + excluded;
	const kinds: [number, string, string][] = (
		[
			[breakdown.transfer, "transfer", "transfers"],
			[breakdown.reimbursement, "reimbursement", "reimbursements"],
			[breakdown.byPerson, "by a person", "by a person"],
		] as [number, string, string][]
	).filter(([n]) => n > 0);
	// Each slice is at least 8 wide so a single exclusion stays visible; the counted part takes the rest.
	const gap = 3;
	const slices = kinds.map(([n]) =>
		Math.max(8, Math.round((W * n) / Math.max(total, 1))),
	);
	const countedW =
		counted > 0 ? W - slices.reduce((a, b) => a + b + gap, 0) : 0;
	let x = countedW;
	const said = kinds.map(([n, one, many]) =>
		one === "by a person" ? `${n} excluded by a person` : plural(n, one, many),
	);
	const sentence =
		said.length < 2
			? said.join("")
			: `${said.slice(0, -1).join(", ")} and ${said.at(-1)}`;
	const desc =
		excluded === 0
			? `All ${plural(counted, "transaction", "transactions")} this month count toward the budget. Nothing is excluded.`
			: `Of ${total} transactions this month, ${counted} count toward the budget and ${excluded} ${excluded === 1 ? "is" : "are"} excluded: ${sentence}.`;
	return (
		<Figure
			id="exclusions-diagram"
			title="What counts and what's excluded"
			desc={desc}
			height={excluded > 0 ? 84 : 62}
		>
			<rect
				x="0"
				y="8"
				width={W}
				height="22"
				rx="4"
				class="fill-rule"
				stroke="none"
			/>
			{countedW > 0 && (
				<rect
					x="0"
					y="8"
					width={countedW}
					height="22"
					rx="4"
					class="fill-muted"
					stroke="none"
				/>
			)}
			{slices.map((w) => {
				const sx = x + gap;
				x = sx + w;
				return (
					<rect
						x={sx}
						y="8"
						width={Math.max(w - 1, 1)}
						height="22"
						rx="3"
						class="fill-paper stroke-ink"
						stroke-width="1.25"
						stroke-dasharray="3 2"
					/>
				);
			})}
			<text x="0" y="52" font-size="14" class="fill-ink">
				{counted} counted
			</text>
			<text
				x={W}
				y="52"
				font-size="14"
				font-weight="600"
				text-anchor="end"
				class="fill-ink"
			>
				{excluded === 0 ? "Nothing excluded" : `${excluded} excluded`}
			</text>
			{excluded > 0 && (
				<text x={W} y="74" font-size="12" text-anchor="end" class="fill-muted">
					{kinds
						.map(([n, one, many]) =>
							one === "by a person" ? `${n} ${one}` : plural(n, one, many),
						)
						.join(" · ")}
				</text>
			)}
		</Figure>
	);
}

/** The four steps that pick a category, in order, with how many transactions each handled. */
export function CategoriesDiagram(c: {
	user: number;
	merchantRule: number;
	jev: number;
	waiting: number;
	income: number;
	/** Jev's threshold as the page says it, like "80%". */
	threshold: string;
}) {
	const income =
		c.income > 0
			? ` ${c.income} ${c.income === 1 ? "is" : "are"} income, which needs no category.`
			: "";
	const steps: [string, number][] = [
		["A person's choice", c.user],
		["A merchant rule", c.merchantRule],
		[`Jev, if ${c.threshold} or more sure`, c.jev],
		["Waits for a person", c.waiting],
	];
	return (
		<Figure
			id="categories-diagram"
			title="Where a transaction's category comes from"
			desc={`Each transaction's category comes from the first step that applies. This month: a person chose ${c.user}, merchant rules ${c.merchantRule}, Jev ${c.jev}, and ${c.waiting} ${c.waiting === 1 ? "waits" : "wait"} for a person.${income}`}
			height={c.income > 0 ? 272 : 244}
		>
			{steps.map(([label, count], i) => (
				<>
					<Step
						y={4 + i * 64}
						label={
							<>
								<tspan font-weight="600">{i + 1}</tspan> {label}
							</>
						}
						count={count}
						dashed={i === 3}
					/>
					{i < 3 && (
						<path d={down(40, 48 + i * 64, 64 + i * 64)} class="stroke-ink" />
					)}
				</>
			))}
			{c.income > 0 && (
				<text x="16" y="266" font-size="13" class="fill-muted">
					+ {c.income} income, which needs no category
				</text>
			)}
		</Figure>
	);
}
