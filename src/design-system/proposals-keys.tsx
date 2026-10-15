// P128 (#72 and #516): where the `?` list of keyboard shortcuts lives, drawn for the owner's sign-off
// before #72 is built (decision 109: the list is drawn and signed off in the catalog first). Every option
// draws the same ledger of keys; the options differ only in where it sits. Proposal only: nothing in
// the app changes. Pictures are inert and labelled, like the rest of the page.

import type { Child } from "hono/jsx";
import { Fixed } from "./proposal-parts";
import {
	Amount,
	Choice,
	Choices,
	Desk,
	HomeTop,
	Phone,
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
 * A keyboard outline for the sidebar line. Tally's icons.tsx has no keyboard icon yet, so this one is
 * drawn here, and a new icon is needed if A is picked.
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

/** Option A's third line in the sidebar's second group: a details that opens the ledger in place. */
function SidebarKeys({ open = false }: { open?: boolean }) {
	return (
		<li>
			<details open={open}>
				<summary class="flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-2 text-lg text-ink">
					<KeyboardIcon />
					Keyboard shortcuts
				</summary>
				{open && (
					<div class="px-2 pb-2 pt-1">
						<Ledger />
					</div>
				)}
			</details>
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

/** Option B's foot: How this works, then the keys' details (open or closed). */
function Foot({ open = false }: { open?: boolean }) {
	return (
		<div class="mt-8 flex flex-col gap-2 border-t border-rule pt-4">
			<a
				href="/how-it-works"
				class="inline-flex min-h-11 items-center text-sm text-muted underline underline-offset-4"
			>
				How this works
			</a>
			<details open={open}>
				<summary class="flex min-h-11 cursor-pointer items-center text-lg">
					Keyboard shortcuts
				</summary>
				{open && (
					<div class="mt-3">
						<Ledger />
					</div>
				)}
			</details>
		</div>
	);
}

/** Home's top, as the page draws it today: unchanged in every option. */
const homeTop = (
	<HomeTop
		amount={<Amount>$1,240</Amount>}
		status="Eating Out is $36 over. Everything else is on track."
	/>
);

/** Option C's sheet over the page on desktop: the BottomSheet's side panel, over a dimmed page. */
const sheetOverHome = (
	<>
		<div class="absolute inset-0 bg-ink/30" />
		<div class="absolute inset-y-0 right-0 flex w-[28rem] flex-col gap-4 overflow-y-auto border-l border-rule bg-paper p-6">
			<p class="font-serif text-2xl font-semibold">Keyboard shortcuts</p>
			<Ledger />
		</div>
	</>
);

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
			<Choices>
				<Choice
					name="A · A sidebar line that opens in place"
					width="w-full"
					recommended
					note="On desktop, the sidebar's second group gains a third line, Keyboard shortcuts, with a keyboard icon. Opening it drops the ledger down inside the sidebar; ? opens it and moves focus to its summary. Phones show nothing: keys are for keyboards, and a phone has no room for them."
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
					<Shot caption="On a phone: Home, unchanged">
						<Phone label="A, Home" tab="home">
							{homeTop}
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="B · At the foot of the page"
					width="w-full"
					recommended={false}
					note="On desktop, Keyboard shortcuts sits at the foot of every page, under How this works, and opens downward. ? opens it and scrolls it into view. Phones don't show it: the foot is hidden below lg."
					cost="a details at every page's foot on desktop"
					why="it adds no sidebar line, and the list sits in the same place at the foot of every page."
				>
					<Shot caption="The foot, closed">
						<Desk label="B, the foot closed">
							{pageEnd}
							<Foot />
						</Desk>
					</Shot>
					<Shot caption="The foot, open">
						<Desk label="B, the foot open" tall={900}>
							{pageEnd}
							<Foot open />
						</Desk>
					</Shot>
					<Shot caption="On a phone: no foot below lg">
						<Phone label="B, Home" tab="home">
							{homeTop}
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="C · A sheet, with the details as its fallback"
					width="w-full"
					recommended={false}
					note="? opens the list as a ledger sheet, the BottomSheet that #87 made modal. Without the script, the page shows B's foot details instead."
					cost="sheet.js already exists; keyboard.js opens the sheet; the fallback is B's details"
					why="it's the sheet people already know from Add a bill, so the keys open what the app does everywhere else."
				>
					<Shot caption="Over Home on desktop: the sheet">
						<Desk label="C, the sheet over Home" overlay={sheetOverHome}>
							{homeTop}
						</Desk>
					</Shot>
					<Shot caption="Without the script: the foot, closed">
						<Desk label="C, the fallback foot">
							{pageEnd}
							<Foot />
						</Desk>
					</Shot>
				</Choice>
			</Choices>
		</Specimen>
	);
}
