// P128 (#72 and #516): where the `?` list of keyboard shortcuts lives, drawn for the owner's sign-off
// before #72 is built (decision 109: the list is drawn and signed off in the catalog first). Every option
// draws the same ledger of keys; the options differ only in where it sits. Below lg the sidebar is hidden
// and the keys' details isn't drawn at the foot (How this works still is), so every option's More ends in a
// Keyboard shortcuts row that opens the same ledger, and one shared picture draws that open row for all of
// them. Proposal only: nothing in the app changes. Pictures are inert and labelled, like the rest of the page.

import { Colophon } from "../views/contents-list";
import { FeedbackButton } from "../views/feedback-button";
import { HowFoot } from "../views/how-link";
import { Icon } from "../views/icons";
import { Key, KeysDetails, Ledger } from "../views/keys";
import { SheetCancel } from "../views/sheet-footer";
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

/**
 * Option A's sidebar line, drawn as the sidebar draws it: the keys' details with the keyboard icon first and the
 * chevron at the far right. The foot and More's row are the real KeysDetails (src/views/keys.tsx); this one is A's alone.
 */
function SidebarKeysDetails({ open = false }: { open?: boolean }) {
	return (
		<details class="group" open={open}>
			<summary class="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-control px-2 text-lg text-ink [&::-webkit-details-marker]:hidden">
				<Icon name="keyboard" class="size-6" />
				Keyboard shortcuts
				<span class="ml-auto shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none">
					<Icon name="chevron-right" class="size-5" />
				</span>
			</summary>
			<div class="px-2 pt-1 pb-2">
				<Ledger />
			</div>
		</details>
	);
}

/** Option A's third line in the sidebar's second group: the keys' details, opened in place. */
function SidebarKeys({ open = false }: { open?: boolean }) {
	return (
		<li>
			<SidebarKeysDetails open={open} />
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

/** B's foot and C's fallback: How this works under its short rule (HowFoot, which each page that has it draws at every width), then the keys' details, drawn on desktop only. */
function Foot({ open = false }: { open?: boolean }) {
	return (
		<>
			<HowFoot section="budget" keys={false} />
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
		howLink={false}
	/>
);

/**
 * Option C's sheet over Home, drawn both ways from one inside: the BottomSheet's side panel on desktop and its bottom
 * sheet on a phone, each over a dimmed page. The title and the ledger sit in the body, and Cancel in a footer under
 * them, as BottomSheet's footer draws it, so the sheet can be shut without the backdrop.
 */
function KeysSheet({ phone = false }: { phone?: boolean }) {
	// 754px is the BottomSheet's max height on an 844px screen: 100svh less the 90px toast room (at least 5.625rem).
	const panel = phone
		? "absolute inset-x-0 bottom-0 flex max-h-[754px] flex-col rounded-t-sheet bg-paper"
		: "absolute inset-y-0 right-0 flex w-[28rem] flex-col rounded-l-sheet bg-paper";
	return (
		<>
			<div class="absolute inset-0 bg-ink/30" />
			<div class={panel}>
				<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
					<p class="font-serif text-2xl font-semibold tracking-tight">
						Keyboard shortcuts
					</p>
					<Ledger />
				</div>
				<div class="shrink-0 border-t border-rule px-5 pt-3 pb-5">
					<SheetCancel href="#p128-keys" />
				</div>
			</div>
		</>
	);
}

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
					<KeysDetails open={open} row />
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
					recommended={false}
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
					note="On desktop, Keyboard shortcuts sits under How this works at the foot of each page that has it, and opens downward. ? opens it and scrolls it into view. Below lg, How this works stays at the foot but Keyboard shortcuts isn't drawn there, so ? opens More's Keyboard shortcuts row instead (from another page, it goes to More with the row open)."
					cost="a details under How this works on each desktop page that has it"
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
					picked
					note="? opens the list as a ledger sheet, the BottomSheet that #87 made modal, at any width. Without the script, the same list is B's details under How this works at the foot of each desktop page that has it, and More's Keyboard shortcuts row below lg."
					cost="a ?keys param the server draws the sheet from over the page it was opened from, so Cancel, Escape and the backdrop close it as every sheet closes; keyboard.js opens it and sheet.js already makes it modal; without the script, the foot's details and More's row; a monospaced font token for the key chips; and a decision entry (decision 118), since decision 109's list was a disclosure only."
					why="it's the sheet people already know from Add a bill, so the keys open what the app does everywhere else."
				>
					<Shot caption="Over Home on desktop: the sheet">
						<Desk
							label="C, the sheet over Home"
							group
							tall={900}
							overlay={<KeysSheet />}
						>
							{homeTop}
						</Desk>
					</Shot>
					<Shot caption="Over Home on a phone: the sheet">
						<Phone
							label="C, the sheet open"
							tab="home"
							masthead={<FeedbackButton />}
							overlay={<KeysSheet phone />}
						>
							{homeTop}
						</Phone>
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
