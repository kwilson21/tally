// P110–P113 (spec §8, §8.1, §8.2 and §9, decision 84): the owner's picks on four choices the polish
// pass turned up (questions 56 to 59), drawn the way the earlier picks were, so the page keeps what
// each pick looked like next to what it was chosen over. Each option is drawn on a phone from the
// real components with demo-style data (today is Mon Oct 5); a piece that no longer exists, like
// Documents in More, or never did, like a toast's Undo, is a prototype in tokens.

import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import { BillRow } from "../views/bill-row";
import { Button } from "../views/button";
import { FEEDBACK_PRIVACY, FeedbackForm } from "../views/feedback-form";
import { HowLink } from "../views/how-link";
import { Fixed, Options } from "./proposal-parts";
import {
	BillsScreen,
	CAR,
	ELECTRIC,
	INTERNET,
	RENT,
	SWIM,
	toPay,
} from "./proposals-phase5-bills";
import {
	actions,
	BLUE_BOTTLE,
	Categories,
	Days,
	GROCERIES,
	LUPITAS,
	PanelForm,
	PanelSheet,
	PanelTop,
	THREE,
	TITLE,
	TODAY,
	Toggles,
	TRADER_JOES,
	TxHeader,
	tx,
} from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// P110: Documents in the menu (question 56).

/** The More page, as the route draws it: a title over a ruled list of plain links. */
function More({ items }: { items: string[] }) {
	return (
		<>
			<h1 class={TITLE}>More</h1>
			<ul class="mt-6 divide-y divide-rule border-y border-rule">
				{items.map((label) => (
					<li>
						<a
							href="#p110-documents-menu"
							class="flex min-h-11 items-center py-3 text-lg text-ink no-underline"
						>
							{label}
						</a>
					</li>
				))}
			</ul>
		</>
	);
}

/** A: Documents isn't listed. */
const moreWithout = (
	<More items={["Accounts", "Settings", "How Tally works"]} />
);

/** B: as before, Documents between Accounts and Settings. */
const moreWith = (
	<More items={["Accounts", "Documents", "Settings", "How Tally works"]} />
);

/** What Documents led to: the shell's placeholder page. */
const documentsPage = (
	<>
		<h1 class={TITLE}>Documents</h1>
		<p class="mt-2 text-muted">This part of Tally isn't built yet.</p>
	</>
);

// ---------------------------------------------------------------------------------------------
// P111: deleting a cash entry (question 57). Farmers market, $20.00, entered yesterday in cash.

const FARMERS = tx(10, "2026-10-04", "Farmers market", 2000, GROCERIES);
const NAME_AND_AMOUNT = `${FARMERS.displayName}, ${formatCents(FARMERS.amountCents)}`;

/** The list behind every sheet: Transactions, with the entry in it. */
const behind = (
	<>
		<TxHeader />
		<Days rows={[BLUE_BOTTLE, FARMERS]} />
	</>
);

/**
 * The cash entry's edit sheet, scrolled to its end, where Delete lives: its top, the category and
 * the two toggle chips (the app shows every category; the pictures show a few), then what the
 * option puts last. `p` keeps each picture's chips in a group of their own.
 */
function EntrySheet({ p, children }: { p: string; children?: Child }) {
	return (
		<PanelSheet behind={behind}>
			<PanelTop row={FARMERS} account="Cash" />
			<PanelForm>
				<Categories p={p} cats={THREE} selected="Groceries" />
				<Toggles p={p} />
				{children}
			</PanelForm>
		</PanelSheet>
	);
}

/** Today's question: a black button that asks, with a Cancel of its own. */
function asksAsButton(brick?: boolean) {
	return (
		<div class="flex items-center gap-3">
			{brick ? (
				<button
					type="button"
					class="min-h-11 rounded-control bg-over px-5 text-paper"
				>
					Delete this cash entry?
				</button>
			) : (
				<Button type="button">Delete this cash entry?</Button>
			)}
			<Button kind="text" type="button">
				Cancel
			</Button>
		</div>
	);
}

/** Cancel and Save with Save outlined too, so Delete would be the one black button. */
const saveOutlined = (
	<div class="grid grid-cols-2 gap-3">
		<Button kind="secondary" type="button" class="w-full">
			Cancel
		</Button>
		<Button kind="secondary" type="button" class="w-full">
			Save
		</Button>
	</div>
);

/** Delete and Keep it, as the app draws them: Delete the one primary, Keep it beside it. */
const deleteOrKeep = (
	<div class="grid grid-cols-2 gap-3">
		<Button type="button" class="w-full">
			Delete
		</Button>
		<Button kind="secondary" type="button" class="w-full">
			Keep it
		</Button>
	</div>
);

const today = (
	<EntrySheet p="p111-today">
		{actions}
		{asksAsButton()}
	</EntrySheet>
);

const saveOutlinedSheet = (
	<EntrySheet p="p111-a">
		{saveOutlined}
		{asksAsButton()}
	</EntrySheet>
);

/** B: the question replaces Cancel and Save, in the words the app uses. */
const questionSheet = (
	<EntrySheet p="p111-b">
		<div class="flex flex-col gap-3">
			<p class="text-lg">{`Delete ${NAME_AND_AMOUNT}? This can't be undone.`}</p>
			{deleteOrKeep}
		</div>
	</EntrySheet>
);

/** C: the sheet as it is, with a small sheet over it asking, and a second dimming between. */
const confirmSheet = (
	<div class="relative">
		<EntrySheet p="p111-c">
			{actions}
			<Button kind="text" type="button" class="self-start">
				Delete cash transaction
			</Button>
		</EntrySheet>
		<div class="absolute -inset-x-5 inset-y-0 bg-ink/30" />
		<div class="absolute -inset-x-5 bottom-0 flex flex-col gap-3 rounded-t-sheet bg-paper p-5">
			<div>
				<p class="text-lg">{`Delete ${NAME_AND_AMOUNT}?`}</p>
				<p class="text-muted">This can't be undone.</p>
			</div>
			{deleteOrKeep}
		</div>
	</div>
);

/**
 * D: after the delete, the list without the entry and a toast with Undo. It sits where every toast
 * does (Layout's #toasts, 9rem above the screen's bottom, which is 88px above the picture's); the
 * real one floats a little, which the token test allows only in toast.js, so it's drawn flat. The
 * toast is text only today: the Undo is the new part.
 */
const deletedWithUndo = (
	<div class="relative h-[680px]">
		<TxHeader />
		<Days rows={[BLUE_BOTTLE, TRADER_JOES, LUPITAS]} />
		<div class="absolute -inset-x-1 bottom-22 flex justify-center">
			<p
				role="status"
				class="flex items-center gap-1 rounded-control border border-rule bg-paper pl-4 pr-2 text-sm text-ink"
			>
				{`Deleted ${NAME_AND_AMOUNT}.`}
				<Button kind="text" type="button">
					Undo
				</Button>
			</p>
		</div>
	</div>
);

/** E: today's layout, the asking button in brick. */
const brickSheet = (
	<EntrySheet p="p111-e">
		{actions}
		{asksAsButton(true)}
	</EntrySheet>
);

// ---------------------------------------------------------------------------------------------
// P112: Send feedback in the demo (question 58).

const NOTHING_SENT =
	"Feedback is off in the demo. Sign in to your Tally to send it.";
const FEEDBACK_VALUES = {
	type: "Idea",
	feeling: "Okay",
	message: "",
	from: "/",
};

/** A: the real page, in the demo: the box right under the title, then the privacy text. */
const offFirst = <FeedbackForm demo values={FEEDBACK_VALUES} />;

/** B: as it was: the privacy text first, the box after it, where this edge cuts it off. */
const offAfter = (
	<div class="max-w-2xl">
		<h1 class="font-serif text-5xl font-semibold tracking-tight">
			Send feedback
		</h1>
		<p class="mt-2 text-muted">{FEEDBACK_PRIVACY}</p>
		<p class="mt-8 rounded-control border border-rule bg-band p-4">
			{NOTHING_SENT}
		</p>
	</div>
);

// ---------------------------------------------------------------------------------------------
// P113: a How this works link on Bills (question 59).

const SOON = [ELECTRIC, SWIM];

/** Bills as the page draws it, with the link or without it. */
function Bills({ link }: { link?: boolean }) {
	return (
		<BillsScreen
			sentence={toPay(
				SOON.length,
				SOON.reduce((n, b) => n + b.amountCents, 0),
			)}
			under={link ? <HowLink section="bills" /> : undefined}
			groups={[
				{
					status: "due",
					rows: SOON.map((b) => <BillRow bill={b} today={TODAY} />),
				},
				{
					status: "upcoming",
					rows: [INTERNET, CAR].map((b) => <BillRow bill={b} today={TODAY} />),
				},
				{ status: "paid", rows: <BillRow bill={RENT} today={TODAY} /> },
			]}
		/>
	);
}

/** P110–P113 on the proposals page, picked (decision 84). */
export function PolishProposals() {
	return (
		<>
			<Specimen
				id="p110-documents-menu"
				title="P110 · Documents in the menu"
				tier="visual"
				sentence="Documents isn't built, but More has listed it, and tapping it opens a page that says so. Pick whether it stays in the menu. Each is More on a phone."
			>
				<Fixed>
					Documents is not built; it moved to the Later list with receipts
					(decision 66, §8's screens table), and its address keeps answering
					inside the shell. The owner's pick follows the rule that no menu item
					leads to a page that isn't built (decision 84): Documents is not in
					More or the sidebar until receipts are.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · More without Documents",
							picked: true,
							note: "More lists Accounts, Settings and How Tally works. Documents leaves the sidebar too, and comes back with receipts.",
							tradeoff:
								"a person who goes looking for Documents finds nothing, and nothing says it's coming.",
							recommended:
								"nothing in the menu leads to a page that isn't built, and nobody loses anything that works.",
							screen: moreWithout,
						},
						{
							name: "Option B · As today, with Documents",
							note: "More lists Documents between Accounts and Settings, so the menu shows what's coming.",
							tradeoff:
								"every visitor can tap into a page that does nothing, the first time they look around.",
							screen: moreWith,
						},
						{
							name: "Option B, next · The page it leads to",
							note: "What Documents opens: its title and one sentence, in the shell.",
							screen: documentsPage,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p111-delete-cash"
				title="P111 · Deleting a cash entry"
				tier="visual"
				sentence="Delete cash transaction is the last thing on a cash entry's sheet, and it asks before it deletes. Pick how it asks. Each is Farmers market, $20.00, entered yesterday in cash, with the sheet scrolled to its end."
			>
				<Fixed>
					Only a cash entry can be deleted, from the end of its own edit sheet
					(§8.2, P21). One primary action per sheet (DESIGN.md), and a step that
					can't be undone names what is lost, as Disconnect a bank does
					(decision 59). The owner chose B combined with D (decision 84): the
					question comes first, and once deleted the toast offers Undo for 10
					seconds, which puts the entry back as it was, its split parts and
					links included. Undo is a safety net under the question, not a
					replacement for it. The Undo is built with its own issue.
				</Fixed>
				<Options
					options={[
						{
							name: "Today · Cancel, Save and a black Delete",
							note: "Delete cash transaction opens a second question under Cancel and Save: a black “Delete this cash entry?” button with a Cancel of its own.",
							tradeoff:
								"two black buttons, Save and the delete one, and two Cancels, one above the other.",
							screen: today,
						},
						{
							name: "Option A · Save outlined",
							note: "The same, with Save outlined while the question is open, so Delete is the one black button.",
							tradeoff:
								"Save looks different here than in every other form, and the two Cancels stay.",
							screen: saveOutlinedSheet,
						},
						{
							name: "Option B · The question replaces Cancel and Save",
							picked: true,
							note: "Picked, combined with D. The sheet asks in one plain sentence, “Delete Farmers market, $20.00? This can't be undone.”, with Delete as the one black button and Keep it, which brings Cancel and Save back. Focus moves to the sentence, so a screen reader reads all of it.",
							tradeoff:
								"one more tap than D alone, and the entry can't be saved while the question is open.",
							recommended:
								"it says what is lost, and the only buttons in view are its two answers.",
							screen: questionSheet,
						},
						{
							name: "Option C · A small sheet to confirm",
							note: "A small sheet rises over the entry's: “Delete Farmers market, $20.00?”, “This can't be undone.”, then Delete and Keep it. The entry stays behind, dimmed.",
							tradeoff:
								"a sheet over a sheet is a new layer with its own focus and its own way out, which nothing else in the app has.",
							screen: confirmSheet,
						},
						{
							name: "Option D · Deleted at once, with Undo",
							picked: true,
							note: "Picked, combined with B: after Delete in B, the sheet closes and the toast says “Deleted Farmers market, $20.00.” with Undo for 10 seconds, which puts the entry back as it was. Alone, D deletes with no question at all.",
							tradeoff:
								"the toast has to stay 10 seconds instead of 4, and Undo has to bring back everything the entry held, its split parts and links.",
							screen: deletedWithUndo,
						},
						{
							name: "Option E · Delete in brick",
							note: "Today's layout with the delete button in brick, the colour that already means a warning.",
							tradeoff:
								"Save stays black, so two filled buttons sit side by side, and brick means over budget everywhere else; a new button needs the catalog and DESIGN.md first.",
							screen: brickSheet,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p112-demo-feedback"
				title="P112 · Send feedback in the demo"
				tier="visual"
				sentence="In the demo, nothing sent from the feedback page goes anywhere, and the page says so. Pick where. Each is the page on a phone, in the demo."
			>
				<Fixed>
					In the demo sending is off, and the family app shows the form instead
					(§8.1, decision 58). The privacy text stays whole and unchanged. The
					owner's pick follows the rule that a screen says what it can't do
					before it asks anything of the reader (decision 84): the off line
					comes first, right under the title.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · The off line first",
							picked: true,
							note: "Right under the title, a band-tinted box says feedback is off in the demo and where to send it, then the privacy text.",
							tradeoff:
								"the privacy text is pushed down by the box, though in the demo nobody needs it.",
							recommended:
								"a visitor learns it's off before reading what it would have stored.",
							screen: offFirst,
						},
						{
							name: "Option B · As today",
							note: "The privacy text comes first, a screen of it, and the box saying it's off sits after it, below this picture's edge.",
							tradeoff:
								"a visitor reads about what's stored before learning the page does nothing.",
							screen: offAfter,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p113-bills-how-link"
				title="P113 · A How this works link on Bills"
				tier="visual"
				sentence="Every main screen explains itself with a small link to its part of How Tally works, and Bills was the one without. Pick whether it gets one. Each is Bills on Oct 5."
			>
				<Fixed>
					Every screen has a small “How this works” link to its feature's
					section of How Tally works (§9), and Bills has its own section. The
					owner's pick (decision 84) follows that rule: Bills gets the same
					HowLink, under its status sentence as on Home, with its own name for a
					screen reader.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · The link under the status sentence",
							picked: true,
							note: "A small “How this works” sits under “2 bills to pay soon”, before Add a bill, and goes to the Bills section.",
							tradeoff: "one more line, 44px of it, before the first bill.",
							recommended:
								"every main screen explains itself the same way, in the same place.",
							screen: <Bills link />,
						},
						{
							name: "Option B · No link",
							note: "As today: Bills is the one main screen without it.",
							tradeoff:
								"a person who wonders why a bill is Due, not Upcoming, has nowhere to look.",
							screen: <Bills />,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
