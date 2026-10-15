// P126 (#202, decisions 101, 115 and 116): where Planned joins the Budget diagram. The owner picked option A
// (decision 115): the boxes keep the size main draws four and never scale down, and where the row doesn't fit
// it wraps after Bills due; decision 116 extends the wrap to every width, with or without Planned. Each picture
// is the Budget section as How Tally works draws it, from the same numbers as its worked example. Today's
// reference is the real BudgetDiagram; the other drawings are local copies that use main's box size
// (93 by 60), gap (22) and type sizes, so they are true to the diagram rather than to a new one.

import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import { BudgetDiagram } from "../views/how-diagrams";
import { Fixed, PickedPill } from "./proposal-parts";
import { Specimen } from "./specimen";

// The demo's October numbers (the delivery session's). Bills due is what the other four leave: $1,062.49.
const BUDGET = 394000;
const SPENT = 253500;
const PLANNED = 27000;
const SAFE = 7251;
const BILLS = BUDGET - SPENT - PLANNED - SAFE;
// Without Planned, the same budget, spending and bills leave $342.51 (today's four boxes).
const TODAY_SAFE = BUDGET - SPENT - BILLS;
// The six-box picture adds a $50.00 savings goal, which leaves $22.51.
const SAVINGS = 5000;
const SIX_SAFE = BUDGET - SPENT - BILLS - PLANNED - SAVINGS;

const money = (cents: number) => formatCents(cents);

/**
 * A desktop picture: the Budget section in How Tally works' real column (lg:max-w-3xl, 768 px), in a
 * frame as wide as this page's column (824 px), so the frame never runs past the page.
 */
function WideFrame({
	id,
	name,
	sum,
	children,
}: {
	id: string;
	name: string;
	/** The whole sum, read aloud as the picture's description; its drawing is inert. */
	sum: string;
	children?: Child;
}) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${name}, on desktop`}
				aria-describedby={`${id}-sum`}
				class="relative h-[240px] w-[824px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<span id={`${id}-sum`} hidden>
					{sum}
				</span>
				<div inert class="mx-auto w-[768px] pt-8">
					{children}
				</div>
			</div>
		</div>
	);
}

/**
 * A phone picture at the brief's 390 by 844: 390 wide and 844 tall inside its border. PhoneFrame is
 * 788 tall because it leaves room for the tab bar, which these pictures don't draw. Scrolled to the
 * Budget section, so the demo banner and the wordmark are not drawn. The content column is 350 px.
 */
function PhonePicture({
	id,
	name,
	sum,
	children,
}: {
	id: string;
	name: string;
	/** The whole sum, read aloud as the picture's description; its drawing is inert. */
	sum: string;
	children?: Child;
}) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${name}, on a phone`}
				aria-describedby={`${id}-sum`}
				class="relative h-[846px] w-[392px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<span id={`${id}-sum`} hidden>
					{sum}
				</span>
				<div inert class="px-5 pt-6">
					{children}
				</div>
			</div>
		</div>
	);
}

/** The Budget section as How Tally works draws it: its heading, then the diagram in its wrapper, nothing else. */
function BudgetPicture({ children }: { children?: Child }) {
	return (
		<>
			<h2 class="font-serif text-3xl font-semibold">
				Budget and safe to spend
			</h2>
			<div class="mt-4">{children}</div>
		</>
	);
}

/**
 * A picture's caption, above it in its option's row. At most the row's width, so a picture wider than
 * the page scrolls inside its own frame instead of pushing the whole page sideways.
 */
function Column({ caption, children }: { caption: string; children?: Child }) {
	return (
		<div class="flex max-w-full flex-col gap-2">
			<p class="text-sm font-medium text-muted">{caption}</p>
			{children}
		</div>
	);
}

/**
 * An option's name, what it is and what it costs and why, above its pictures. proposal-parts' Options
 * holds one picture at one width, and this row needs two (1280 and 390), so it lays out the same
 * heading and weighing itself.
 */
function Choice({
	name,
	note,
	tradeoff,
	why,
	recommended = false,
	picked = false,
	children,
}: {
	name: string;
	note: string;
	tradeoff?: string;
	why?: string;
	recommended?: boolean;
	/** The owner's pick (decision 115 for option A). */
	picked?: boolean;
	children?: Child;
}) {
	return (
		<div class="flex flex-col gap-3">
			<div class="flex flex-col gap-1">
				<h4 class="flex flex-wrap items-center gap-x-2 font-semibold">
					{name}
					{recommended && (
						<span class="rounded-full border border-ink px-2.5 py-0.5 text-sm font-medium">
							Recommended
						</span>
					)}
					{picked && <PickedPill />}
				</h4>
				<p class="text-sm">{note}</p>
				{tradeoff && <p class="text-sm text-muted">Trade-off: {tradeoff}</p>}
				{why && <p class="text-sm text-muted">Why: {why}</p>}
			</div>
			<div data-screen="picture" class="flex flex-wrap items-start gap-8">
				{children}
			</div>
		</div>
	);
}

// Main's four-box geometry, as BudgetDiagram draws it at width 440: a box 93 wide and 60 tall, and a
// 22 px gap that holds an operator.
const BOX = 93;
const SLOT = 22;
const LINE_H = 68;

type Cell = { op: string } | { label: string; cents: number; last?: boolean };
const op = (sign: string): Cell => ({ op: sign });
const box = (label: string, cents: number, last = false): Cell => ({
	label,
	cents,
	last,
});

/**
 * One line of boxes at its natural size: each box is main's four-box size and each operator sits in a
 * 22 px slot, so the line is as wide as its cells. The line is never scaled, and it is aria-hidden: the
 * wrapper that holds the lines is the one labelled picture.
 */
function Line({ cells }: { cells: Cell[] }) {
	const width = cells.reduce(
		(sum, cell) => sum + ("op" in cell ? SLOT : BOX),
		0,
	);
	let x = 0;
	return (
		<svg
			aria-hidden="true"
			class="shrink-0"
			width={width}
			height={LINE_H}
			viewBox={`0 0 ${width} ${LINE_H}`}
			fill="none"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			overflow="visible"
		>
			{cells.map((cell) => {
				const left = x;
				if ("op" in cell) {
					x += SLOT;
					return (
						<text
							x={left + SLOT / 2}
							y="40"
							font-size="18"
							text-anchor="middle"
							class="fill-ink"
						>
							{cell.op}
						</text>
					);
				}
				x += BOX;
				const cx = left + BOX / 2;
				const over = cell.cents < 0;
				return (
					<g>
						<rect
							x={left}
							y="4"
							width={BOX}
							height="60"
							rx="8"
							class={
								cell.last ? (over ? "stroke-over" : "stroke-ok") : "stroke-ink"
							}
							stroke-width={cell.last ? "2.5" : undefined}
						/>
						<text
							x={cx}
							y="28"
							font-size="13"
							text-anchor="middle"
							class={
								cell.last ? (over ? "fill-over" : "fill-ok") : "fill-muted"
							}
						>
							{cell.label}
						</text>
						<text
							x={cx}
							y="50"
							font-size="15"
							font-weight="600"
							text-anchor="middle"
							class="fill-ink"
						>
							{money(cell.cents)}
						</text>
					</g>
				);
			})}
		</svg>
	);
}

/**
 * The row of Budget boxes as one labelled picture. Its lines are SVGs of their own, so they wrap as
 * text does. The title and description sit in sr-only text (as the views hide theirs): the picture
 * names itself from the title and describes itself from the description, as the branch's figure does.
 */
function BudgetBoxes({
	id,
	desc,
	lines,
}: {
	id: string;
	desc: string;
	lines: Cell[][];
}) {
	return (
		<div
			role="img"
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-desc`}
			class="flex flex-wrap gap-y-2"
		>
			<span id={`${id}-title`} class="sr-only">
				How safe to spend is worked out
			</span>
			<span id={`${id}-desc`} class="sr-only">
				{desc}
			</span>
			{lines.map((cells) => (
				<Line cells={cells} />
			))}
		</div>
	);
}

/** Budget's two lines: Budget − Spent − Bills due, then − Planned = Safe to spend. */
const ROW_ONE: Cell[] = [
	box("Budget", BUDGET),
	op("−"),
	box("Spent", SPENT),
	op("−"),
	box("Bills due", BILLS),
];
const ROW_TWO: Cell[] = [
	op("−"),
	box("Planned", PLANNED),
	op("="),
	box("Safe to spend", SAFE, true),
];
/** With a savings goal too, the second line is longer: 345 px, which fits a phone's 350 px column. */
const ROW_TWO_WITH_GOAL: Cell[] = [
	op("−"),
	box("Planned", PLANNED),
	op("−"),
	box("Savings goal", SAVINGS),
	op("="),
	box("Safe to spend", SIX_SAFE, true),
];

/** The sum as the picture's description reads it aloud, the way the branch words its figure. */
const SUM = `The ${money(BUDGET)} budget minus ${money(SPENT)} spent minus ${money(BILLS)} for bills due minus ${money(PLANNED)} for planned expenses`;
const SAFE_DESC = `${SUM} leaves ${money(SAFE)} safe to spend.`;
const SIX_DESC = `${SUM} minus ${money(SAVINGS)} for the savings goal leaves ${money(SIX_SAFE)} safe to spend.`;
const TODAY_DESC = `The ${money(BUDGET)} budget minus ${money(SPENT)} spent minus ${money(BILLS)} for bills due leaves ${money(TODAY_SAFE)} safe to spend.`;

/**
 * PR #545's BudgetDiagram for five boxes, copied from its branch: one row 550 wide, so the five boxes
 * shrink to fit the figure's max-w-md width, as they do on that branch. Safe to spend is positive here,
 * so it is drawn green.
 */
function BranchFiveBoxes({ id }: { id: string }) {
	const boxes: [string, number][] = [
		["Budget", BUDGET],
		["Spent", SPENT],
		["Bills due", BILLS],
		["Planned", PLANNED],
		["Safe to spend", SAFE],
	];
	const width = 550;
	const gap = 22;
	const boxW = (width - 2 - gap * (boxes.length - 1)) / boxes.length;
	return (
		<svg
			class="h-auto w-full max-w-md"
			viewBox={`0 0 ${width} 68`}
			fill="none"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			role="img"
			aria-labelledby={`${id}-title ${id}-desc`}
		>
			<title id={`${id}-title`}>How safe to spend is worked out</title>
			<desc id={`${id}-desc`}>{SAFE_DESC}</desc>
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
							class={last ? "stroke-ok" : "stroke-ink"}
							stroke-width={last ? "2.5" : undefined}
						/>
						<text
							x={cx}
							y="28"
							font-size="13"
							text-anchor="middle"
							class={last ? "fill-ok" : "fill-muted"}
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
		</svg>
	);
}

/** P126 on the proposals page, drawn first: the Budget diagram with Planned, at 1280 and at 390. */
export function PlannedDiagramProposal() {
	return (
		<Specimen
			id="p126-planned-diagram"
			title="P126 · The Budget diagram with Planned"
			tier="visual"
			sentence="Planned joins the Budget diagram as a fifth box. Each picture is the Budget section of How Tally works, as the page draws it, at 1280 and at 390."
		>
			<Fixed>
				the diagram is drawn by code from the same numbers as the section's
				worked example; its title and description read the whole sum aloud; Safe
				to spend is the last box, green when it's zero or more and terracotta
				when it's over.
			</Fixed>
			<Choice
				name="Reference · Today on main: four boxes"
				note="The diagram as main draws it now: four boxes with the demo's numbers and no Planned box."
			>
				<Column caption="At 1280: one row">
					<WideFrame
						id="p126-today-1280-frame"
						name="Reference · Today on main: four boxes"
						sum={TODAY_DESC}
					>
						<BudgetPicture>
							<BudgetDiagram
								id="p126-today-1280"
								totalBudgetCents={BUDGET}
								totalSpentCents={SPENT}
								safeToSpendCents={TODAY_SAFE}
								savingsGoalCents={0}
							/>
						</BudgetPicture>
					</WideFrame>
				</Column>
				<Column caption="At 390: one row, scaled down">
					<PhonePicture
						id="p126-today-390-frame"
						name="Reference · Today on main: four boxes"
						sum={TODAY_DESC}
					>
						<BudgetPicture>
							<BudgetDiagram
								id="p126-today-390"
								totalBudgetCents={BUDGET}
								totalSpentCents={SPENT}
								safeToSpendCents={TODAY_SAFE}
								savingsGoalCents={0}
							/>
						</BudgetPicture>
					</PhonePicture>
				</Column>
			</Choice>
			<Choice
				name="Reference · PR #545 as built: five boxes in one row"
				note="Planned as a fifth box in the same row. All five share one width, so every box and label shrinks."
			>
				<Column caption="At 1280: one row, scaled down">
					<WideFrame
						id="p126-545-1280-frame"
						name="Reference · PR #545 as built: five boxes in one row"
						sum={SAFE_DESC}
					>
						<BudgetPicture>
							<BranchFiveBoxes id="p126-545-1280" />
						</BudgetPicture>
					</WideFrame>
				</Column>
				<Column caption="At 390: the labels shrink to fit one row">
					<PhonePicture
						id="p126-545-390-frame"
						name="Reference · PR #545 as built: five boxes in one row"
						sum={SAFE_DESC}
					>
						<BudgetPicture>
							<BranchFiveBoxes id="p126-545-390" />
						</BudgetPicture>
					</PhonePicture>
				</Column>
			</Choice>
			<Choice
				name="Option A · Today's box size, wrapping after Bills due"
				note="Planned is a fifth box at today's size. Where the row doesn't fit, it wraps after Bills due, and decision 116 extends the wrap to the four-box diagram too, with or without Planned."
				tradeoff="a two-part diagram: the boxes split into two groups that wrap, instead of one SVG that scales; no new token, no JavaScript."
				why="the labels stay the size they are today on every screen, and the sum still reads left to right."
				recommended
				picked
			>
				<Column caption="At 1280: one row">
					<WideFrame
						id="p126-a-1280-frame"
						name="Option A · Today's box size, wrapping after Bills due"
						sum={SAFE_DESC}
					>
						<BudgetPicture>
							<BudgetBoxes
								id="p126-a-1280"
								desc={SAFE_DESC}
								lines={[ROW_ONE, ROW_TWO]}
							/>
						</BudgetPicture>
					</WideFrame>
				</Column>
				<Column caption="At 390: the row wraps after Bills due">
					<PhonePicture
						id="p126-a-390-frame"
						name="Option A · Today's box size, wrapping after Bills due"
						sum={SAFE_DESC}
					>
						<BudgetPicture>
							<BudgetBoxes
								id="p126-a-390"
								desc={SAFE_DESC}
								lines={[ROW_ONE, ROW_TWO]}
							/>
						</BudgetPicture>
					</PhonePicture>
				</Column>
				<Column caption="With a savings goal too: six boxes, the same rule">
					<PhonePicture
						id="p126-a-six-frame"
						name="Option A with a savings goal"
						sum={SIX_DESC}
					>
						<BudgetPicture>
							<BudgetBoxes
								id="p126-a-six"
								desc={SIX_DESC}
								lines={[ROW_ONE, ROW_TWO_WITH_GOAL]}
							/>
						</BudgetPicture>
					</PhonePicture>
				</Column>
			</Choice>
		</Specimen>
	);
}
