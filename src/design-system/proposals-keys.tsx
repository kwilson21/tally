// P128 (#72 and #516): where the `?` list of keyboard shortcuts lives, drawn for the owner's sign-off
// before #72 is built (decision 109: the list is drawn and signed off in the catalog first). Every option
// draws the same ledger of keys; the options differ only in where it sits. Below lg (no sidebar, no foot),
// every option's More ends in a Keyboard shortcuts row that opens the same ledger, so one shared picture
// draws that open row for all of them. Proposal only: nothing in the app changes. Pictures are inert and
// labelled, like the rest of the page.

import type { Child } from "hono/jsx";
import { Button } from "../views/button";
import { Colophon } from "../views/contents-list";
import { FeedbackButton } from "../views/feedback-button";
import { HowFoot } from "../views/how-link";
import { Icon } from "../views/icons";
import { Fixed } from "./proposal-parts";
import { TITLE } from "./proposals-phase5-transactions";
import {
	Amount,
	Choice,
	Choices,
	Desk,
	Entry,
	HomeTop,
	Phone,
	PLACES,
	Shot,
} from "./proposals-polish-4";
import { Specimen } from "./specimen";

/** One key, as a chip: its name centred in a small box with a rule. */
function Key({ children }: { children?: Child }) {
	return (
		<kbd class="inline-flex min-h-6 min-w-6 items-center justify-center rounded-control border border-rule px-1.5 font-mono text-sm">
			{children}
		</kbd>
	);
}

type Row = {
	keys: string[];
	/** How several keys join: "/" for "j / k", "or" for "e or Enter". */
	joined?: "/" | "or";
	words: string;
	/** Beyond decision 109's sentence, so it waits for the owner's yes (#72's list, or #516's u). */
	confirm?: boolean;
	/** One more muted line under the words. */
	note?: string;
};

// The ledger: the same in every option. Enter and the arrows are in #72's own list, and u is #516's
// key; the rest is decision 109's sentence.
const LEDGER: { heading: string; rows: Row[] }[] = [
	{
		heading: "Anywhere",
		rows: [
			{ keys: ["/"], words: "Search transactions" },
			{ keys: ["?"], words: "Show these keys" },
		],
	},
	{
		heading: "In a list",
		rows: [
			{ keys: ["j", "k"], joined: "/", words: "Next row / previous row" },
			{
				keys: ["e", "Enter"],
				joined: "or",
				words: "Open the row",
				confirm: true,
			},
		],
	},
	{
		heading: "On Home",
		rows: [
			{
				keys: ["←", "→"],
				joined: "/",
				words: "Previous month / next month",
				confirm: true,
			},
		],
	},
	{
		heading: "After a change",
		rows: [
			{
				keys: ["u"],
				words: "Undo it, while its toast shows",
				confirm: true,
				note: "New (#516): needs your yes.",
			},
		],
	},
];

function RowKeys({ row }: { row: Row }) {
	return (
		<span class="flex shrink-0 items-center gap-1">
			{row.keys.map((k, i) => (
				<>
					{i > 0 && (
						<span class="text-sm text-muted">
							{row.joined === "or" ? "or" : "/"}
						</span>
					)}
					<Key>{k}</Key>
				</>
			))}
		</span>
	);
}

/** The ledger of keys, as the `?` list shows it in every option. */
function Ledger() {
	return (
		<div class="flex flex-col gap-3">
			{LEDGER.map((section) => (
				<div>
					<p class="text-sm font-medium text-muted">{section.heading}</p>
					<ul class="mt-1 divide-y divide-rule border-y border-rule">
						{section.rows.map((row) => (
							<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
								<RowKeys row={row} />
								<span class="text-sm">{row.words}</span>
								{row.confirm && (
									<span class="rounded-full border border-rule px-2.5 text-sm text-muted">
										to confirm
									</span>
								)}
								{row.note && (
									<span class="w-full text-sm text-muted">{row.note}</span>
								)}
							</li>
						))}
					</ul>
				</div>
			))}
			<p class="text-sm text-muted">
				Keys don't work while you're typing in a field. In a sheet, Escape
				closes it.
			</p>
		</div>
	);
}

/**
 * A keyboard outline for the keys' icon. Tally's icons.tsx has no keyboard icon yet, so this one is
 * drawn here, and a new icon is needed whichever option is picked, since More's row draws it too.
 */
function KeyboardIcon() {
	return (
		<svg
			class="size-6"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<rect x="2" y="5" width="20" height="14" rx="2" />
			<path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10" />
		</svg>
	);
}

/**
 * The keys' one disclosure, in every place it sits, drawn as Bills' Inactive draws its own: a chevron that
 * turns when open. `icon` leads with the keyboard icon and puts the chevron at the far right (the sidebar's
 * line); without it the chevron comes first (the foot). `row` is More's row, in the rows' grid. Open, the
 * ledger sits under the summary.
 */
function KeysDetails({
	open = false,
	icon = false,
	row = false,
}: {
	open?: boolean;
	icon?: boolean;
	row?: boolean;
}) {
	const turn = (
		<span
			class={`shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none${icon ? " ml-auto" : ""}`}
		>
			<Icon name="chevron-right" class="size-5" />
		</span>
	);
	const layout = row
		? "grid min-h-16 grid-cols-[1.5rem_1fr_auto] items-center gap-x-4 py-3"
		: icon
			? "flex min-h-11 items-center gap-3 rounded-control px-2"
			: "flex min-h-11 items-center gap-2";
	const ledgerClass = row ? "pb-3" : icon ? "px-2 pb-2 pt-1" : "mt-3";
	return (
		<details class="group" open={open}>
			<summary
				class={`${layout} cursor-pointer list-none text-lg text-ink [&::-webkit-details-marker]:hidden`}
			>
				{icon ? <KeyboardIcon /> : turn}
				Keyboard shortcuts
				{icon && turn}
			</summary>
			{open && (
				<div class={ledgerClass}>
					<Ledger />
				</div>
			)}
		</details>
	);
}

/** Option A's third line in the sidebar's second group: the keys' details, opened in place. */
function SidebarKeys({ open = false }: { open?: boolean }) {
	return (
		<li>
			<KeysDetails open={open} icon />
		</li>
	);
}

// The bottom of a page, drawn as Home ends: a few budget rows above the foot, so the foot has a page
// above it. The numbers are the demo's own (the Riveras in October).
const PAGE_END_ROWS = [
	{ name: "Groceries", spent: "$395", budget: "$700" },
	{ name: "Eating Out", spent: "$286", budget: "$250" },
	{ name: "Gas", spent: "$186", budget: "$200" },
];

const pageEnd = (
	<ul class="divide-y divide-rule border-y border-rule">
		{PAGE_END_ROWS.map((row) => (
			<li class="flex h-14 items-center justify-between gap-4">
				<span class="text-lg">{row.name}</span>
				<span class="text-sm text-muted">
					{row.spent} of {row.budget}
				</span>
			</li>
		))}
	</ul>
);

/** Option B's foot: How this works under its short rule (HowFoot), then the keys' details (open or closed). */
function Foot({ open = false }: { open?: boolean }) {
	return (
		<>
			<HowFoot section="budget" />
			<div class="mt-2">
				<KeysDetails open={open} />
			</div>
		</>
	);
}

/** Home's top, as the page draws it today: unchanged in every option. */
const homeTop = (
	<HomeTop
		amount={<Amount>$1,240</Amount>}
		status="Eating Out is $36 over. Everything else is on track."
	/>
);

/**
 * Option C's sheet over Home on desktop: the BottomSheet's side panel over a dimmed page. Its Close sits in a
 * footer under the ledger, as BottomSheet's footer draws it, so the sheet can be shut without the backdrop.
 */
const sheetOverHome = (
	<>
		<div class="absolute inset-0 bg-ink/30" />
		<div class="absolute inset-y-0 right-0 flex w-[28rem] flex-col border-l border-rule bg-paper">
			<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
				<p class="font-serif text-2xl font-semibold">Keyboard shortcuts</p>
				<Ledger />
			</div>
			<div class="shrink-0 border-t border-rule px-6 pt-3 pb-6">
				<Button kind="secondary" type="button" class="w-full">
					Close
				</Button>
			</div>
		</div>
	</>
);

/**
 * More at a phone's size below lg, drawn as the live More draws it (P122 A, #559 and #563): its title, its
 * places, then Keyboard shortcuts as a last row. Open, it is scrolled (no title): the list starts 12px above
 * the picture's top edge (-mt-9 against Phone's 24px), so the whole open ledger clears the tab bar.
 */
function KeysMore({ label, open = false }: { label: string; open?: boolean }) {
	return (
		<Phone
			label={label}
			tab="more"
			masthead={<FeedbackButton />}
			scrolled={open}
		>
			{!open && <h1 class={TITLE}>More</h1>}
			<ul
				class={`${open ? "-mt-9" : "mt-6"} divide-y divide-rule border-y border-rule`}
			>
				{PLACES.map((place) => (
					<li>
						<Entry place={place} />
					</li>
				))}
				<li>
					<KeysDetails open={open} icon row />
				</li>
			</ul>
			<Colophon demo />
		</Phone>
	);
}

export function KeyboardListProposal() {
	return (
		<Specimen
			id="p128-keys"
			title="P128 · The keyboard shortcuts list"
			tier="visual"
			sentence="Where the ? list lives: in the sidebar, at the foot of each page, or as a sheet. Each open list shows the same ledger of keys. Pick one."
		>
			<Fixed>
				Decision 109 (keyboard.js). <Key>/</Key> focuses search, <Key>?</Key>{" "}
				opens this list, <Key>j</Key> and <Key>k</Key> move between a list's
				rows; no key acts while typing in a field, with Ctrl, Alt or Cmd held,
				or while a sheet is open (Escape belongs to the sheet); the list is a
				&lt;details&gt; that reads without the script.
			</Fixed>
			<p class="max-w-prose text-sm">
				In every option, below lg (a phone, a narrow window or a tablet with a
				keyboard), More's contents end in a Keyboard shortcuts row: the same
				details, opening the same ledger.
			</p>
			<Shot caption="Below lg, in every option: More, Keyboard shortcuts open">
				<KeysMore label="All options, More with Keyboard shortcuts open" open />
			</Shot>
			<Choices>
				<Choice
					name="A · A sidebar line that opens in place"
					width="w-full"
					recommended
					note="On desktop, the sidebar's second group gains a third line, Keyboard shortcuts, with a keyboard icon. Opening it drops the ledger down inside the sidebar; ? opens it and moves focus to its summary. Below lg the sidebar is hidden, so ? opens More's Keyboard shortcuts row instead (from another page, it goes to More with the row open)."
					cost="a sidebar line and a details; keyboard.js only opens it; a keyboard icon, and Tally has none yet, so a new icon is needed."
					why="the list sits with the sidebar's other links and never moves the page under a person's hands."
				>
					<Shot caption="The sidebar, closed">
						<Desk label="A, the sidebar closed" group extra={<SidebarKeys />}>
							{homeTop}
						</Desk>
					</Shot>
					<Shot caption="Open: the ledger in the sidebar">
						<Desk
							label="A, the sidebar open"
							group
							tall={1200}
							extra={<SidebarKeys open />}
						>
							{homeTop}
						</Desk>
					</Shot>
					<Shot caption="Below lg: More, Keyboard shortcuts closed">
						<KeysMore label="A, More" />
					</Shot>
				</Choice>
				<Choice
					name="B · At the foot of the page"
					width="w-full"
					recommended={false}
					note="On desktop, Keyboard shortcuts sits at the foot of every page, under How this works, and opens downward. ? opens it and scrolls it into view. Below lg the foot is hidden, so ? opens More's Keyboard shortcuts row instead (from another page, it goes to More with the row open)."
					cost="a details at every page's foot on desktop"
					why="it adds no sidebar line, and the list sits in the same place at the foot of every page."
				>
					<Shot caption="The foot, closed">
						<Desk label="B, the foot closed" group>
							{pageEnd}
							<Foot />
						</Desk>
					</Shot>
					<Shot caption="The foot, open">
						<Desk label="B, the foot open" group tall={900}>
							{pageEnd}
							<Foot open />
						</Desk>
					</Shot>
					<Shot caption="Below lg: More, Keyboard shortcuts closed">
						<KeysMore label="B, More" />
					</Shot>
				</Choice>
				<Choice
					name="C · A sheet, with the details as its fallback"
					width="w-full"
					recommended={false}
					note="? opens the list as a ledger sheet, the BottomSheet that #87 made modal, at any width. Without the script, the page shows B's foot details on desktop and More's Keyboard shortcuts row below lg."
					cost="sheet.js already exists; keyboard.js opens the sheet; the fallback is B's details"
					why="it's the sheet people already know from Add a bill, so the keys open what the app does everywhere else."
				>
					<Shot caption="Over Home on desktop: the sheet">
						<Desk
							label="C, the sheet over Home"
							group
							tall={900}
							overlay={sheetOverHome}
						>
							{homeTop}
						</Desk>
					</Shot>
					<Shot caption="Without the script: the foot, closed">
						<Desk label="C, the fallback foot" group>
							{pageEnd}
							<Foot />
						</Desk>
					</Shot>
					<Shot caption="Below lg: More, Keyboard shortcuts closed">
						<KeysMore label="C, More" />
					</Shot>
				</Choice>
			</Choices>
		</Specimen>
	);
}
