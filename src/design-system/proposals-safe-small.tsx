// P127 (#500 part 1): Home's Safe to spend row on a small phone, drawn for the owner's pick (decision 47).
// Each picture is Home's top as the app draws it, in a frame 320, 360 or 390 px wide, so its content lays out
// at that width. Each one draws the demo banner, with its Start here link, above the masthead, as the demo Home
// does. How this works sits at Home's foot since #592, so the pictures leave it out. The frame is a container,
// so a width rule reads the frame, not the window. Whatever runs past the frame's right edge shows past a
// terracotta guide line, in the room the wrapper leaves; the caption is the fit measured in Chrome at those
// widths. Every frame is 478 px tall, the tallest picture's content (Option C's), so nothing spills onto its
// caption. The pictures include #566's fix for the minus (#500 part 2, not on main yet), which keeps the minus
// with its number, so the amount never wraps.

import { formatCents } from "../money";
import { Wordmark } from "../views/brand";
import { FeedbackButton } from "../views/feedback-button";
import { headlineAmountClass } from "../views/headline-amount";
import { LedgerIllustration } from "../views/illustration";
import { DemoBanner } from "../views/layout";
import { MonthNavigation } from "../views/month-navigation";
import { WhyLink } from "../views/why-link";
import { Choice, Choices } from "./proposals-polish-4";
import { Specimen } from "./specimen";

// The demo's example amounts: $9,999 and −$9,999 (the minus is the true sign, U+2212, as Home draws it).
const POSITIVE = formatCents(999900, { wholeDollars: true });
const NEGATIVE = `−${POSITIVE}`;
const DEMO_STATUS = "Eating Out is $36 over. Everything else is on track.";
const OVER_STATUS =
	"Over budget this month. Spending more takes it further over.";

type Width = 320 | 360 | 390;
/** Each width written out in full, so Tailwind keeps the class. */
const FRAME_WIDTH: Record<Width, string> = {
	320: "w-[320px]",
	360: "w-[360px]",
	390: "w-[390px]",
};

/** Where the drawing goes on a phone: beside the amount as today, left out below 390 px, 72 px beside it, or under the amount. */
type Layout = "today" | "hide" | "small" | "under";

/** The six pictures of an option, in order: 320, 360, then 390 px, each with $9,999 above −$9,999 (width-major). */
const SHOTS: [Width, boolean][] = [
	[320, false],
	[320, true],
	[360, false],
	[360, true],
	[390, false],
	[390, true],
];

/**
 * The measured fit of each picture, in SHOTS' order: Chrome (Playwright) at 320, 360 and 390 px, the content's
 * right edge against the frame's right edge, rounded to whole px. "Fits" when nothing passes the edge.
 */
const FITS: Record<Layout, string[]> = {
	today: [
		"Spills 25 px",
		"Spills 55 px",
		"Fits",
		"Spills 15 px",
		"Fits",
		"Fits",
	],
	hide: ["Fits", "Fits", "Fits", "Fits", "Fits", "Fits"],
	small: ["Fits", "Spills 7 px", "Fits", "Fits", "Fits", "Fits"],
	under: ["Fits", "Fits", "Fits", "Fits", "Fits", "Fits"],
};

/** The notebook drawing beside the amount, at a phone's width. Its size is set on the svg, so the app's lg: size can't win. */
function Drawing({ layout }: { layout: Exclude<Layout, "under"> }) {
	const look = {
		today: "shrink-0 [&>svg]:size-28",
		hide: "hidden @min-[390px]:block shrink-0 [&>svg]:size-28",
		small: "shrink-0 [&>svg]:size-18",
	}[layout];
	return (
		<div data-drawing="beside" class={look}>
			<LedgerIllustration />
		</div>
	);
}

/**
 * Home's top as HomeTop draws it at a phone's width. The pictures include #566's fix for the minus: the
 * real month navigation, Safe to spend with its Why? link, the amount with the minus kept with its number,
 * and the status sentence. How this works is left out: since #592 it sits at Home's foot, not here.
 */
function HomeTop({
	amount,
	negative,
	layout,
}: {
	amount: string;
	negative: boolean;
	layout: Layout;
}) {
	const label = (
		<p class="text-lg text-muted">
			Safe to spend · <WhyLink section="budget" topic="safe to spend" />
		</p>
	);
	const figure = (
		<p
			class={`font-serif text-6xl font-semibold tracking-tight whitespace-nowrap ${negative ? "text-over" : ""} ${headlineAmountClass(amount)}`}
		>
			{amount}
		</p>
	);
	const status = negative ? OVER_STATUS : DEMO_STATUS;
	return (
		<>
			<MonthNavigation
				month="2026-10"
				firstMonth="2026-05"
				currentMonth="2026-10"
			/>
			{layout === "under" ? (
				<>
					<div class="mt-2">
						{label}
						{figure}
					</div>
					<div class="mt-3 flex items-start justify-between gap-6">
						<p class="min-w-0 flex-1 font-serif text-lg italic">{status}</p>
						<div data-drawing="under" class="shrink-0 [&>svg]:size-28">
							<LedgerIllustration />
						</div>
					</div>
				</>
			) : (
				<>
					<div
						class={`mt-2 flex items-center justify-between ${layout === "small" ? "gap-4" : "gap-6"}`}
					>
						<div>
							{label}
							{figure}
						</div>
						<Drawing layout={layout} />
					</div>
					<p class="mt-3 font-serif text-lg italic">{status}</p>
				</>
			)}
		</>
	);
}

/** The room each width's wrapper leaves for its widest spill, written out in full so Tailwind keeps each class. */
const ROOM: Record<Width, string> = {
	320: "pr-16",
	360: "pr-4",
	390: "pr-2",
};

/**
 * One picture: a frame at a phone's width, with its content in an inert page and a terracotta guide
 * line at the frame's right edge. The inert page draws the demo banner above the masthead, as the demo
 * Home does. The frame's own overflow stays visible, so a spill shows past the line; its wrapper leaves
 * room for it and scrolls only past that. The room is per width, in ROOM: 320 px keeps 64 px for its
 * widest spill (55 px), 360 px keeps 16 px for its own (15 px), and 390 px never spills, so it keeps 8 px.
 * The widest row is then 390 px, 2 × 398 + 16 = 812 px, inside the 824 px card. The frame is 478 px tall,
 * the tallest picture's content (Option C's, measured in Chrome at 1280, 390 and 320 px), so no picture runs past
 * its bottom.
 */
function Screen({
	name,
	width,
	negative,
	layout,
}: {
	name: string;
	width: Width;
	negative: boolean;
	layout: Layout;
}) {
	const amount = negative ? NEGATIVE : POSITIVE;
	return (
		<div class={`w-fit max-w-full overflow-x-auto ${ROOM[width]}`}>
			<div
				role="img"
				aria-label={`${name}, ${width} px wide, with ${amount}, on a phone`}
				class={`@container relative h-[478px] shrink-0 ${FRAME_WIDTH[width]} rounded-control bg-paper ring-1 ring-inset ring-ink`}
			>
				<div inert>
					<DemoBanner />
					<div class="px-5 pt-6">
						<div class="mb-2 flex items-center justify-between gap-3">
							<Wordmark />
							<FeedbackButton />
						</div>
						<HomeTop amount={amount} negative={negative} layout={layout} />
					</div>
				</div>
				<span
					aria-hidden="true"
					class="absolute inset-y-0 -right-px w-px bg-accent"
				/>
			</div>
		</div>
	);
}

/**
 * The six pictures of one option, two columns: each row is one width, 320, 360 then 390 px, with $9,999 on
 * the left and −$9,999 on the right.
 */
function Pictures({ name, layout }: { name: string; layout: Layout }) {
	return (
		<div class="max-w-full overflow-x-auto">
			<div class="grid w-max grid-cols-2 gap-x-4 gap-y-6">
				{SHOTS.map(([width, negative], i) => (
					<figure class="flex w-fit flex-col gap-2">
						<Screen
							name={name}
							width={width}
							negative={negative}
							layout={layout}
						/>
						<figcaption class="text-sm text-muted">
							{width} px with {negative ? NEGATIVE : POSITIVE}:{" "}
							{FITS[layout][i]}
						</figcaption>
					</figure>
				))}
			</div>
		</div>
	);
}

/** P127: four options for Home's Safe to spend row on a small phone, each drawn at 320, 360 and 390 px. */
export function SafeToSpendSmallProposal() {
	return (
		<Specimen
			id="p127-safe-small"
			title="P127 · Safe to spend on a small phone"
			tier="visual"
			sentence="Home's Safe to spend row at 320, 360 and 390 px, with $9,999 and −$9,999: the notebook stays beside the amount, goes, shrinks, or moves under it. Each caption is the measured fit."
		>
			<p class="max-w-prose text-sm">
				<span class="font-medium">In every picture: </span>#566's fix for #500
				part 2 (not on main yet) keeps the minus with its number; #388's size
				rule steps a long amount down; the drawing is decoration and never
				carries meaning.
			</p>
			<Choices>
				<Choice
					name="Reference · Today on main"
					note="What main draws now, plus #566's fix that keeps the minus with its number: the 112 px notebook sits beside the amount."
					width="w-[824px]"
				>
					<Pictures name="Reference · Today on main" layout="today" />
				</Choice>
				<Choice
					name="Option A · No drawing below 390 px"
					note="Below 390 px the notebook is left out for amounts of 7 characters or fewer, like $9,999 and −$9,999, and below 640 px for 8 or more, like −$19,999 and $199,999, so the amount has the whole row. Elsewhere it stays beside the amount, as today. No picture's amount reaches 8 characters, so the pictures show only the 390 px edge."
					cost="a wrapper div around the drawing in home-top.tsx, hidden below 390 px for 7 characters or fewer and below 640 px for 8 or more. Home is 8 px shorter at 320 and 360 px and the same at 390 px."
					why="it fits all six pictures, and of those options it changes Home's height least."
					width="w-[824px]"
				>
					<Pictures name="Option A · No drawing below 390 px" layout="hide" />
				</Choice>
				<Choice
					name="Option B · A smaller drawing on phones"
					note="Below the desktop breakpoint the notebook is 72 px with a 16 px gap beside the amount; desktop keeps its own size."
					cost="a wrapper div with its own size and gap in home-top.tsx, below lg. Home is 8 px shorter."
					width="w-[824px]"
				>
					<Pictures
						name="Option B · A smaller drawing on phones"
						layout="small"
					/>
				</Choice>
				<Choice
					name="Option C · The drawing under the amount"
					note="On phones the notebook moves under the amount, right-aligned beside the status sentence, so the amount has the full width; desktop keeps today's row."
					cost="markup in home-top.tsx: the row splits in two on phones. Home is 48 px taller at 320, 360 and 390 px."
					width="w-[824px]"
				>
					<Pictures
						name="Option C · The drawing under the amount"
						layout="under"
					/>
				</Choice>
			</Choices>
		</Specimen>
	);
}
