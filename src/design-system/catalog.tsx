// The catalog's content (decisions 42–44): every component from src/views/, imported and given
// typed fake data, so what's shown here is exactly what the app renders.
import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import type { NetWorthView } from "../net-worth";
import {
	buildTrends,
	type ChangeData,
	compareSentence,
	type MonthPoint,
	monthsLabel,
	type TrendRowData,
	type TrendsPage,
	trendsAmount,
} from "../trends";
import { AccountRow } from "../views/account-row";
import { AccountsTop } from "../views/accounts-top";
import { AdjustLink } from "../views/adjust-link";
import { Band } from "../views/band";
import { BankGroup } from "../views/bank-group";
import { BillFindingBand, BillFindingRow } from "../views/bill-finding";
import { BillOccurrenceRow } from "../views/bill-occurrence-row";
import { BillPaymentPicker } from "../views/bill-payment-picker";
import { BillRow, BillStatusHeading } from "../views/bill-row";
import { BottomSheet } from "../views/bottom-sheet";
import { TallyMark, Wordmark } from "../views/brand";
import { Button } from "../views/button";
import { CashForm } from "../views/cash-form";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { ErrorPage } from "../views/error-page";
import { FeedbackButton } from "../views/feedback-button";
import { FeedbackForm } from "../views/feedback-form";
import { FilterSelect } from "../views/filter-select";
import { HomeTop } from "../views/home-top";
import {
	BillsDiagram,
	BudgetDiagram,
	CategoriesDiagram,
	ExclusionsDiagram,
	TransactionsDiagram,
} from "../views/how-diagrams";
import { HowLink } from "../views/how-link";
import { ICON_NAMES, Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { MoneyInput } from "../views/money-input";
import { NameChoices, pickValue } from "../views/name-choices";
import { NetWorthChart } from "../views/net-worth-chart";
import { PendingNote } from "../views/pending-note";
import { ProgressRow } from "../views/progress-row";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { SplitForm } from "../views/split-form";
import { Switch } from "../views/switch";
import { SystemDiagram } from "../views/system-diagram";
import { TextInput } from "../views/text-input";
import { ThingsToTry } from "../views/things-to-try";
import { TimeZoneRow } from "../views/time-zone-row";
import { TransactionRow } from "../views/transaction-row";
import {
	ChangeRow,
	MonthBars,
	TrendGroup,
	TrendRow,
	TrendsScreen,
	TrendsTop,
} from "../views/trends";
import { ViewLinks } from "../views/view-links";
import { WhyLink } from "../views/why-link";
import {
	ADJUST_ROWS,
	BAND,
	BANK_LINES,
	BANKS,
	BUDGET_EXAMPLE,
	CATEGORIES_EXAMPLE,
	CHECKING,
	CREDIT_CARD,
	EXCLUSIONS_EXAMPLE,
	HOME_ROWS,
	HOME_TOP,
	MONEY_STATES,
	NET_WORTH_CENTS,
	NET_WORTH_VIEWS,
	PROGRESS_ROWS,
	TRANSACTION_ROWS,
	TRANSACTIONS_EXAMPLE,
	TRENDS_EARLY_INPUT,
	TRENDS_EMPTY_INPUT,
	TRENDS_FIRST_MONTH_INPUT,
	TRENDS_INPUT,
	TRENDS_PART_INPUT,
} from "./mock";
import {
	MotionSpec,
	PhoneFrame,
	Specimen,
	State,
	TierPill,
	UseSpec,
	type UseSpecText,
} from "./specimen";
import {
	CATEGORY_COLORS,
	COLOR_TOKENS,
	DURATION_TOKENS,
	TYPE_ROLES,
} from "./tokens";

const SECTIONS = [
	["foundation", "Foundation"],
	["brand", "Brand and icons"],
	["shell", "Page shell"],
	["home", "Home's top"],
	["accounts", "Accounts"],
	["trends", "Trends"],
	["rows", "Rows"],
	["controls", "Controls"],
	["feedback", "Feedback and sheets"],
	["demo", "Guidance"],
	["diagrams", "Diagrams"],
] as const;

function Group({
	id,
	title,
	children,
}: {
	id: (typeof SECTIONS)[number][0];
	title: string;
	children?: Child;
}) {
	return (
		<section id={id} aria-labelledby={`${id}-title`} class="mt-12">
			<h2 id={`${id}-title`} class="font-serif text-3xl font-semibold">
				{title}
			</h2>
			{children}
		</section>
	);
}

function Intro() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Design system
			</h1>
			<p class="mt-3 max-w-prose text-lg">
				Every part of Tally's interface, in each of its states. Each one is the
				real component the app uses, given sample data, so this page can't show
				something the app doesn't. The rules are in DESIGN.md.
			</p>
			<p class="mt-2">
				<a
					href="/design-system/proposals"
					class="inline-flex min-h-11 items-center"
				>
					Proposals, open and decided
				</a>
			</p>
			<dl class="mt-6 grid gap-3 sm:grid-cols-3">
				{(
					[
						[
							"visual",
							"Static states side by side. Nothing here can reach the server.",
						],
						[
							"interactive",
							"Works in your browser without the server: try it.",
						],
						[
							"flow",
							"A journey of several steps, on its own page. The first flows come next.",
						],
					] as const
				).map(([tier, text]) => (
					<div class="flex flex-col items-start gap-1">
						<dt>
							<TierPill tier={tier} />
						</dt>
						<dd class="text-muted">{text}</dd>
					</div>
				))}
			</dl>
			<nav aria-label="Catalog sections" class="mt-6">
				<ul class="flex flex-wrap gap-x-5">
					{SECTIONS.map(([id, title]) => (
						<li>
							<a href={`#${id}`} class="inline-flex min-h-11 items-center">
								{title}
							</a>
						</li>
					))}
				</ul>
			</nav>
		</>
	);
}

function Foundation() {
	return (
		<Group id="foundation" title="Foundation">
			<Specimen
				id="colors"
				title="Colors"
				tier="visual"
				sentence="Every color token, its use, and its contrast on paper. Status and category colors never share a hue."
			>
				<ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{COLOR_TOKENS.map((t) => (
						<li class="flex items-center gap-3">
							<span
								class={`size-12 shrink-0 rounded-control border border-rule ${t.swatch}`}
							/>
							<span class="min-w-0">
								<span class="block font-medium">
									{t.name} <span class="text-muted">{t.hex}</span>
								</span>
								<span class="block text-sm text-muted">
									{t.use} · {t.contrast}
								</span>
							</span>
						</li>
					))}
				</ul>
			</Specimen>
			<Specimen
				id="type"
				title="Type roles"
				tier="visual"
				sentence="Newsreader for the one thing that matters on a screen; Inter with tabular numerals for everything else."
			>
				{TYPE_ROLES.map((r) => (
					<State label={`${r.role} · ${r.classes}`}>
						<p class={r.classes}>{r.sample}</p>
					</State>
				))}
			</Specimen>
			<Specimen
				id="radii"
				title="Radii and depth"
				tier="visual"
				sentence="Two radii, drawn as squircles where the browser supports it, and pills. No shadows except toasts: hairline rules separate things instead."
			>
				<div class="flex flex-wrap gap-6">
					<State label="rounded-control · inputs, buttons, tags, cards, the toast">
						<span class="block h-16 w-28 rounded-control border border-ink" />
					</State>
					<State label="rounded-sheet · the sheet's top corners, the panel's left corners">
						<span class="block h-16 w-28 rounded-t-sheet border border-ink" />
					</State>
					<State label="rounded-full · pills: chips, round ticks, round buttons">
						<span class="block h-11 w-28 rounded-full border border-ink" />
					</State>
				</div>
			</Specimen>
			<Specimen
				id="motion"
				title="Motion"
				tier="visual"
				sentence="Quiet confirmations in CSS only (decision 76): a switch's knob slides, a sheet rises, a toast fades in, and pages cross-fade, each over in 150 to 200 ms; the budget bars fill on load. Nothing counts up or bounces, and reduced motion shows every end state with nothing moving. Each move is a class in app.css that names a duration token below, never a length, and is written into its component's use spec: the Switch, the Toast, the BottomSheet and the page shell, in the sections that follow."
			>
				<State label="Duration tokens (app.css @theme): a rule names one, never a length">
					<dl class="max-w-prose divide-y divide-rule border-y border-rule">
						{DURATION_TOKENS.map((t) => (
							<div class="py-3 sm:grid sm:grid-cols-[14rem_1fr] sm:gap-4">
								<dt class="font-medium">
									duration-{t.name} <span class="text-muted">{t.value}</span>
								</dt>
								<dd class="mt-1 text-muted sm:mt-0">{t.use}</dd>
							</div>
						))}
					</dl>
				</State>
				<State label="The budget bar fills on load (reload the page to see it again)">
					<ul>
						{PROGRESS_ROWS.slice(0, 1).map((s) => (
							<ProgressRow {...s.props} />
						))}
					</ul>
				</State>
				<State label="Where to see the rest: tap a Switch, press Show a saved toast, open the bottom sheet's page, and follow a link between catalog pages">
					<p class="max-w-prose text-muted">
						Each plays here as it does in the app. Set your device to reduce
						motion and each one shows its end state at once.
					</p>
				</State>
			</Specimen>
		</Group>
	);
}

function Brand() {
	return (
		<Group id="brand" title="Brand and icons">
			<Specimen
				id="wordmark"
				title="Wordmark and TallyMark"
				tier="visual"
				components={["Wordmark", "TallyMark"]}
				sentence="The tally-mark glyph plus serif “Tally”; the brand."
			>
				<div class="flex flex-wrap items-center gap-8">
					<Wordmark />
					<span class="text-ink">
						<TallyMark class="size-12" />
					</span>
				</div>
			</Specimen>
			<Specimen
				id="icon"
				title="Icon"
				tier="visual"
				components={["Icon"]}
				sentence="Lucide line icons, 1.75 stroke, currentColor, always aria-hidden."
			>
				<ul class="grid grid-cols-3 gap-4 sm:grid-cols-6 lg:grid-cols-8">
					{ICON_NAMES.map((name) => (
						<li class="flex flex-col items-center gap-1 text-center">
							<Icon name={name} />
							<span class="text-xs text-muted">{name}</span>
						</li>
					))}
				</ul>
			</Specimen>
			<Specimen
				id="category-icon"
				title="CategoryIcon"
				tier="visual"
				components={["CategoryIcon"]}
				sentence="A category's line icon, drawn in its color token."
			>
				<ul class="flex flex-wrap gap-6">
					{CATEGORY_COLORS.map((color) => (
						<li class="flex flex-col items-center gap-1">
							<CategoryIcon icon="groceries" color={color} />
							<span class="text-xs text-muted">{color}</span>
						</li>
					))}
				</ul>
			</Specimen>
			<Specimen
				id="illustration"
				title="LedgerIllustration"
				tier="visual"
				components={["LedgerIllustration"]}
				sentence="The notebook-and-pencil line drawing beside the headline; ink plus a terracotta pencil."
			>
				<LedgerIllustration />
			</Specimen>
		</Group>
	);
}

function Shell() {
	return (
		<Group id="shell" title="Page shell">
			<Specimen
				id="layout"
				title="Layout, Sidebar and BottomTabs"
				tier="visual"
				components={["Layout", "Sidebar", "BottomTabs"]}
				sentence="Every page's shell: banner, navigation, main, toast and announce regions. The same destinations are a sidebar on desktop and four tabs plus More on phones."
			>
				<p class="max-w-prose">
					This page is drawn inside the real Layout, so its demo banner,
					navigation, toast region and announcer are the app's own. Widen or
					narrow the window to see the sidebar and the tabs. No item is current
					here, because the catalog isn't one of the destinations.
				</p>
				<p class="max-w-prose">
					On phones, keyboard scrolling leaves room below focused content for
					the fixed tabs and Feedback pill; desktop has no bottom padding.
				</p>
				<MotionSpec>
					Pages cross-fade in 150 ms through the browser's own View Transitions,
					with no script: every page opts in with{" "}
					<code>
						@view-transition {"{"} navigation: auto; {"}"}
					</code>{" "}
					in app.css, which Layout loads on every page, and the browser's 250 ms
					is set to the confirmation token. Chrome and Edge 126 and later and
					Safari 18.2 and later play it; Firefox doesn't yet and just switches
					pages, as before. Reduced motion: the rule only applies where motion
					is welcome, so pages switch at once. A swap inside a page (a filter,
					one of Adjust's taps) never fades the page: htmx's transitions setting
					stays off. To see it, follow a link from this page to the bottom
					sheet's page and back.
				</MotionSpec>
			</Specimen>
		</Group>
	);
}

/** Home's Budget heading with its Adjust switch, as Home draws it. */
function BudgetHeading({ adjusting }: { adjusting: boolean }) {
	// Here Adjust and Done jump between the two states, rather than leaving for Home.
	return (
		<div
			id={adjusting ? "adjust-on" : "adjust-off"}
			class="flex max-w-xl items-baseline justify-between"
		>
			<h4 class="font-serif text-3xl font-semibold">Budget</h4>
			<AdjustLink
				adjusting={adjusting}
				href={adjusting ? "#adjust-off" : "#adjust-on"}
			/>
		</div>
	);
}

// Adjust mode's use spec (#94): every line answered before the owner signs it off.
const ADJUST_SPEC: UseSpecText = {
	purpose:
		"Nudge a budget up or down by $10 right where you see it, without opening its sheet.",
	affordance:
		"“Adjust” is terracotta text beside the Budget heading. In Adjust mode every budgeted row has a round − before it and a round + after it, the same buttons as the money input's ±$1, visible without hovering. On a phone, − takes the category icon's place so the name and amount fit. The row itself is still a link to its sheet, for an exact amount.",
	states:
		"Rest: muted glyph on paper, with a hairline ring. Hover: the glyph turns ink. Focus: the focus-visible ring. Disabled: − at $0 and + at $1,000,000, faded to 40%, and named so a screen reader hears why. Loading: taps queue in order and the row keeps its amount until the new one arrives; “Saving…” comes with #69. Done: the new amount is in the row. Error: if the category was archived on another screen, the list comes back without it.",
	feedback:
		"The row's “of $710” changes in place, and so do Safe to spend and the status sentence, because they count the budget too. Focus stays on the button you tapped, so you can keep tapping. A toast says “Groceries is $710 a month”, with Undo once #70 lands. The announcer reads “Groceries is $710 a month from September on.”",
	input:
		"Touch: 44px round buttons, no gestures. Keyboard: Tab goes −, the row, + for each row in turn; Enter or Space presses. Screen reader: “Lower Groceries to $690, button” and “Raise Groceries to $710, button”; at $0, “Kids is at $0, button, dimmed”. The switch reads “Adjust budgets” and “Done adjusting budgets”.",
	motion:
		"None added. In Adjust mode the bars don't replay their fill on each tap: they redraw at the new width at once, so the list stays still. Day to day they fill on load as before, and reduced motion shows the end state.",
	edges:
		"$0: − is off. $1,000,000: + is off. Cents ($712.40): − goes to $710 and + to $720. Over budget: the row stays brick until a tap takes the budget past the spending. A long name, or a narrow phone: the amount moves under the name, and if it still doesn't fit (“$10,000 of $1,000,000” at 320px) it breaks at “of”, never inside a number. No budgeted categories: no Adjust link. Not budgeted categories keep “Add a budget” and get no buttons; an archived category with spending this month gets none either. Slow network: taps queue and apply in order. Two phones tapping at once: both taps count, because each is read and saved in one step. No JavaScript: Adjust is a link to Home in Adjust mode, and each button is a form that saves and comes back to it.",
	words:
		"Adjust · Done · Lower {name} to {amount} · Raise {name} to {amount} · {name} is at $0 · {name} is at the largest budget · Toast: {name} is {amount} a month · Announced: {name} is {amount} a month from {month} on. · At a limit, toast and announced: {name} is already $0 · {name} is already the largest budget.",
};

// The stale-bank line's use spec (decision 72, P37 A): every line answered before the owner signs it off.
const BANK_LINE_SPEC: UseSpecText = {
	purpose:
		"Tell a person, right under the number it affects, that a bank has stopped syncing, so Safe to spend may be too high, and take them to Accounts to fix it.",
	affordance:
		"An alert icon and a sentence in ink say it without color; “Check Accounts” is terracotta text like every link, on its own line with a 44px target. The line isn't tinted, so the Band stays Home's one highlighted row.",
	states:
		"Shown: a connected bank needs signing in, or hasn't synced for 3 days, counted from the household's today. Not shown: every bank healthy and synced within 2 days, a disconnected bank, a bank with no recorded sync that doesn't need attention, and the whole demo. The link has rest, the focus-visible ring and pressed; hover, disabled and loading don't apply to a plain link.",
	feedback:
		"“Check Accounts” opens Accounts, where the bank says “Needs attention: sign in again” with Fix connection, or shows its “Synced …” line next to Sync now. Once the bank is fixed or syncs again, the line is gone the next time Home loads. Nothing is announced: it is part of the page, not an answer to something a person did.",
	input:
		"Touch: the link is 44px tall. Keyboard: Tab reaches it after “How this works”; Enter follows it. Screen reader: the sentence, then “Check Accounts, link”; the icon is hidden from it because the words carry the meaning.",
	motion: "None.",
	edges:
		"A bank that needs signing in and hasn't synced says the sign-in words. With two or more, the first in the order they were linked is named and the rest counted. A long bank name wraps with the sentence. With no Band (nothing needs a category) the line is the last thing in Home's top. A last sync from another year adds its year (“Dec 30, 2025”). No JavaScript: it's a plain link. The demo never shows it: it has no real banks to fix.",
	words:
		"“{bank} hasn't synced since {Oct 1}, so Safe to spend may be too high.” · “{bank} needs you to sign in again, so Safe to spend may be too high.” · “{bank} needs you to sign in again, and 1 other bank needs a look, so Safe to spend may be too high.” (“2 other banks need a look” for more) · Link: Check Accounts.",
};

// The Switch's use spec (decision 73, P41 B): every line answered before the owner signs it off.
const SWITCH_SPEC: UseSpecText = {
	purpose:
		"Let a person turn one thing on or off and see which, in words. It's the control for the AI suggestions in Settings, where the household chooses what Tally may suggest.",
	affordance:
		"A track with a knob, and “On” or “Off” written beside it, so the state never rests on color or position alone. The whole row is the target, 44px tall, with the pointer hand. Off is a pale track with the knob on the left; on is an ink track with the knob on the right.",
	states:
		"Off: pale track, ink knob left, the word Off. On: ink track, paper knob right, the word On. Hover: no change (touch has none). Focus: the focus-visible ring around the row, for the keyboard. Pressed: it turns at once, with no separate pressed look. Disabled (greyed out, P86 A): the label and the word go muted, the track keeps a rule-coloured edge with a muted knob, the checkbox is disabled so it posts nothing, the row isn't a pointer target, and a muted line under it says what it needs, so the greying never rests on color alone; it still shows its saved On or Off, and the form's Save leaves that setting as it was. Loading, done and error: not applicable. A switch changes nothing until its form's Save, which has its own busy and error states.",
	feedback:
		"The track, knob and word change the moment it is tapped. Nothing is saved until Save is pressed. Then the toast says what was saved, the announcer reads every switch's state, and focus returns to Save. Without JavaScript Save posts the form and the page comes back at the group.",
	input:
		"Touch: the whole 44px row. Keyboard: Tab to it, Space turns it. Screen reader: “Income, switch, on”, then its muted line. The On and Off words and the track are hidden from it, because it already says its state.",
	motion:
		"The knob slides in 150 ms, ease-out, and the track and knob swap tones as it goes; the word changes from On to Off (or back) at the same moment. The classes are switch-track and switch-knob in app.css, on the confirmation token. Reduced motion shows the end state at once, with nothing moving.",
	edges:
		"A long name or line wraps beside the switch and never under it; the word and the track keep their width. With no muted line it is the name alone. No JavaScript: it's a plain checkbox that posts “on” when on and nothing when off, so the server reads a field left out as off, and the form always carries the whole group. At 320px the row still fits the name, word and track side by side.",
	words:
		"The label is the person's word for the feature (“Categories and exclusions”, “Income”), never the name of the AI behind it. The state is exactly “On” or “Off”, never “Enabled” or “Disabled”. Save's words: Save · Saving… · Toast: Saved AI suggestions · Announced: Saved AI suggestions. Categories and exclusions on, income off.",
};

// The merchant-name choices' use spec (decision 64, P29 A, decision 80, P87 B): every line answered before the owner signs it off.
const NAME_CHOICES_SPEC: UseSpecText = {
	purpose:
		"Let a person decide what a merchant is called when there are names for it: take one of the suggestions (Tally's guesses, or the name the bank sent), keep the bank's own text tidied, or type their own. Nothing is renamed until they do.",
	affordance:
		"Up to three suggested names as pill choices. Under Tally's guesses go the sparkles icon, “Tally's guess” and a Why?; under the name the bank sent goes “From your bank” in muted words, with no icon and nothing to explain. Then a pill that says Keep with the bank's text tidied, then a field called “Or your own”, then a muted line saying how many transactions the name is for. Each pill is 44px tall and a real radio button. Nothing is chosen to start with, so saving the panel for another reason never renames the merchant.",
	states:
		"Resting: no pill chosen, the field empty. Chosen: the pill shows an ink border and a pale fill (never color alone: the choice is also the one ticked for a screen reader), and only one of the names or Keep can be chosen. Typing: a name in the field wins over a pill. Hover: no change. Focus: the focus-visible ring around the pill or the field. Error: the field's message in role=alert and the field shaking once (“Keep the name under 80 characters.”, “Pick one of the names shown.”); what was chosen and typed stays. Disabled and loading: not applicable; the form's own Save shows its busy state.",
	feedback:
		"Choosing changes the pill at once. Saving swaps the panel back to the list with a toast that says what was done (“Renamed 9 transactions to Blue Bottle Coffee”, “Kept the bank's name for 9 transactions”), the announcer repeats it, and focus returns to the row. In Settings the next merchant comes up with the toast and the count left, and focus moves to the bank's text above it. Without JavaScript Save posts and redirects.",
	input:
		"Touch: every pill and the field are 44px tall. Keyboard: Tab to the group, the arrow keys move between the pills, Tab on to the field. Screen reader: “Name, group”; each suggestion reads “Blue Bottle Coffee, radio button, not checked, Tally's guess” (or “From your bank”); the Keep pill reads without it; then “Or your own, edit”, described by the muted line that says a typed name replaces any name above and how many transactions it is for.",
	motion: "None added. Reduced motion changes nothing.",
	edges:
		"One name, two or three. A very long name wraps inside its pill and the pills wrap onto another line; they are never cut off. The Keep pill quotes the tidied text, which can be long, and wraps too. The muted line under the field says “A name typed here is used instead of any name above.” followed by how many transactions the name is for. With one transaction it says “A name typed here is used instead of any name above. For the 1 transaction from this merchant.” A typed name over 80 characters is refused. A stale page can't choose a name that isn't offered any more: each pill posts its own name, and one that isn't offered is refused. No JavaScript: plain radio buttons and a text field in a form.",
	words:
		"Name · Tally's guess · From your bank · Why? · Keep “{Blue bottle cof}” · Or your own · A name typed here is used instead of any name above. · For all {9} transactions from this merchant. · For the 1 transaction from this merchant. · Errors: Keep the name under 80 characters. · Pick one of the names shown. · Pick a name, keep the bank's, or type your own. Never the name of the AI behind it.",
};

// The BottomSheet's use spec: every line answered, with its motion (decisions 76 and 80, P74 A, P85 A).
const BOTTOM_SHEET_SPEC: UseSpecText = {
	purpose:
		"Make one change over the list it came from, without leaving it: a transaction's edit panel, a budget, adding cash.",
	affordance:
		"A dimmed backdrop (ink at 30%) over the page, and on it a paper sheet with curved top corners against a phone's bottom edge, or a panel against the right edge on desktop. The page behind stays in view, so it reads as over the list. Cancel, a secondary button, closes it, and so does the backdrop.",
	states:
		"Closed: not drawn. Opening: the motion below. Open: the sheet and backdrop at rest. Loading and error belong to the form inside (a Save that is pending, a field's error in role=alert); a failed request leaves the sheet as it is, with what was typed, and a toast says so. Hover, pressed and disabled: not applicable to the sheet itself.",
	feedback:
		"It opens when a row is tapped, and focus moves in by autofocus (the title or the first field), so a screen reader starts there. Cancel or the backdrop bring the list back with focus on the row that was open; a save does the same with a toast and an announcement.",
	input:
		"Touch: the backdrop is the whole page behind the sheet, and Cancel is 44px tall. Keyboard: Tab goes through the sheet's controls; Escape isn't supported (it would need JavaScript), and the backdrop is out of the Tab order because Cancel does the same. Screen reader: a dialog named by the sheet's heading. It isn't a modal, so the page behind isn't hidden from it.",
	motion:
		"It arrives in 200 ms, ease-out. On a phone the sheet rises from the bottom edge while its backdrop fades in; at desktop width (1024px and up) the panel slides in from the right edge while its backdrop fades in. The classes are fade-in and sheet-panel in app.css, on the rising token. Closing is at once. It plays only when it opens: a swap that draws the open sheet again (a field's error, the delete question, Add a part, Keep it) leaves it still, so an error never looks like the sheet closing and opening, and the field's own shake is seen. Reduced motion shows the sheet and backdrop at once, with nothing moving.",
	edges:
		"Tall content scrolls inside the sheet (at most 90% of the screen's height on a phone, the full height on desktop), and the safe areas keep it clear of a notch and the home indicator. Without JavaScript the sheet is a page of its own, and Cancel and the backdrop are links.",
	words:
		"The backdrop's name for a screen reader is “Close”. The sheet is named by its title (the category, the transaction's name); every other word is its form's.",
};

// The Toast's use spec: every line answered, with its motion (decision 76, P74 A).
const TOAST_SPEC: UseSpecText = {
	purpose:
		"Tell a person that what they just did worked, or didn't, in one sentence, without taking them anywhere.",
	affordance:
		"A small paper pill with a hairline rule and the only lift Tally allows, near the bottom of the screen (above the tab bar on a phone). It isn't a control, so nothing about it looks pressable. An error one leads with the alert icon in the over token, so it is never colour alone.",
	states:
		"Success: the words. Error: the alert icon, then the words. Each stays for 4 seconds and goes; several at once stack with a gap. Hover, focus, pressed, disabled and loading: not applicable, because it can't be touched.",
	feedback:
		"It appears after an HTMX change (HX-Trigger toast) or a failed request, and the announcer says the same words (announce), so a screen reader hears it. Focus stays where it was, and taps pass through the toast, so a Save under it can be tapped again.",
	input:
		"Touch and keyboard: none, and nothing in it takes focus. Screen reader: a success is role=status and an error is role=alert; the announcer region says the HX-Trigger announce text.",
	motion:
		"It fades in and rises 8 px in 150 ms, ease-out, holds, then fades out in 150 ms. That is one animation as long as its stay, 4 seconds, the same as toast.js's DISPLAY_MS, and the fade-out is over 150 ms early, so the toast is invisible 150 ms before the script takes it out (the script's timer starts a frame before the animation does, so a fade-out timed to the very end would be cut off); the script doesn't change. The CSS is set on whatever #toasts holds, on the toast and confirmation tokens. Reduced motion shows it at once with nothing moving, and it is still taken out after 4 seconds.",
	edges:
		"Long words wrap inside the pill. It sits above an open sheet (z-60), so a failed save can be read over it. A burst of identical failures shows one. Without JavaScript there is no toast: the page comes back showing the change.",
	words:
		"A success says what was saved (“Saved Groceries' budget.”). A failed request says “Couldn't save. Check your connection and try again.” (“Couldn't load…” for a GET). A missing page says “This page isn't here.”",
};

// The FilterSelect's use spec (P63 A, P64 B): every line answered before the owner signs it off.
const FILTER_SELECT_SPEC: UseSpecText = {
	purpose:
		"Let a person narrow a list by one thing: Transactions' Month, Category, Account and Show. Several sit side by side, and the list and its count follow each choice.",
	affordance:
		"A pill with a thin rule, the chosen option in ink and the browser's own arrow at its end, 44px tall. It is a real select, so a phone opens its own picker. It reads as a pill like a Chip, because it narrows the list the way a Chip does.",
	states:
		"Rest: the chosen option, or the first (“All categories”, “All accounts”, “All”) when none is chosen. Open: the browser's own list. Focus: the focus-visible ring, for the keyboard. Hover, pressed, disabled, loading and error: not applicable. The list swaps as the choice changes, and a choice that can't be made isn't offered.",
	feedback:
		"With JavaScript the list and its count swap in place a moment after a choice and the page's address follows, so the view can be shared. The count above the list names the choice (“12 transactions in Chase Card ••9921, October”), which is what a screen reader announces. Without JavaScript the Apply filters button submits the same form.",
	input:
		"Touch: the whole 44px pill. Keyboard: Tab to it, arrow keys or typing the first letters change it. Screen reader: “Account, combo box, Chase Card ••9921”; its label is read but never shown, since the chosen option already says what it is.",
	motion: "None. The browser draws its own list.",
	edges:
		"A long option shortens inside its pill (max width is its row), so a long account name never pushes the page sideways; at 320px the pills wrap to the next row. A disconnected bank's account says “· Disconnected” in words after its name. A saved link to an account that's since been removed keeps it as the choice, named by its id (“account 999”), so the pill shows the filter the list is using. Month lists only months with transactions, then “All months”. Without JavaScript it is a plain select inside a form that submits.",
	words:
		"Month: {October} · All months. Category: All categories · {the household's categories}. Account: All accounts · {Chase Card ••9921} · {Cash} · {Old Savings ••3340 · Disconnected}. Show: All · Spending · Income · Refunds · Excluded.",
};

// The demo's two view links' use spec (decisions 73 and 79, P44 A): every line answered before the owner signs it off.
const VIEW_LINKS_SPEC: UseSpecText = {
	purpose:
		"Let a visitor to the demo see the same Transactions list as the bank sends it, next to what Tally made of it, so they can see what Tally did for them. It exists only in the demo.",
	affordance:
		"Two links in words under the page title with a dot between them: “Tidied by Tally · Straight from the bank”. The one you're on is ink and semibold with no underline; the other is a terracotta link, as every link is. Each is 44px tall.",
	states:
		"Current: ink, semibold, not underlined, and aria-current=“page”, so the state is also in words for a screen reader, not weight and color alone. The other: terracotta. Hover: no change (touch has none). Focus: the focus-visible ring. Pressed: the page loads. Disabled, loading, done and error: not applicable, since a link either goes or it doesn't.",
	feedback:
		"A link loads the same page in the other view. The rows change, and the result count, which is the page's live line, ends “, as the bank sends them” (or stops saying it), so it always says which view is shown. The raw view adds one muted line under the count. Nothing else changes: Home's numbers never do. Search and filters stay as they were, and paging starts again at the first page. A filter change updates both links, so they never name a stale filter.",
	input:
		"Touch: each link is 44px tall, and the dot and the gap keep the two apart. Keyboard: Tab to each, Enter follows it. Screen reader: “View, navigation”, then “Tidied by Tally, current page, link” and “Straight from the bank, link”; the dot is hidden from it.",
	motion: "None added. Reduced motion changes nothing.",
	edges:
		"Demo only: the family app has neither the links nor the view, and ignores ?raw=1. No JavaScript: they are plain links. On a 320px phone both still fit on one line, and larger text wraps them onto a second line rather than cutting them off. A search or filter in the address stays when you switch. The note under the count names the demo's own transfer to Savings and paycheck, because that is what its data has.",
	words:
		"View (the nav's name) · Tidied by Tally · Straight from the bank · the count ends “, as the bank sends them” · “No clean names or categories, and the transfer to Savings and the paycheck both count in Spent.” Never the name of the AI behind it.",
};

// The time zone row's use spec (decision 72, P35 A): every line answered before the owner signs it off.
const TIME_ZONE_SPEC: UseSpecText = {
	purpose:
		"Let the household choose the time zone Tally uses for “today”, so a new month starts and a bill falls due at the household's own midnight. It's the one row in Settings' Household group.",
	affordance:
		"A row like a category row: “Time zone” at the left, the zone's everyday name at the right (“Eastern”), and a chevron at the far end. The whole row is the target, 44px tall, with the pointer hand. Opened, it holds a select of the six US zones and then “Other time zones”, a muted line saying what the zone decides, Save as the primary button and Cancel as the secondary one.",
	states:
		"Closed: the row with the saved zone's name. Open: the chevron turned down and the form below. Hover: no change (touch has none). Focus: the focus-visible ring on the row, the select and each button, for the keyboard. Save: rest, pressed, and “Saving…” with the spinner, disabled while it saves. Error: the row opens, the select takes the error look with its words under it in role=alert, and nothing was saved. Disabled and done: not applicable; a saved zone shows as the new name.",
	feedback:
		"Save: the group swaps in place and comes back closed with the new name at the right, a toast says “Saved time zone”, the announcer says “Saved time zone. Months and bills now follow Central time.”, and focus goes to the row, since the swap replaced Save. Cancel closes the row with focus on it. Without JavaScript Save posts the form and Settings comes back at the group. Nothing changes until Save.",
	input:
		"Touch: the row, the select and both buttons are 44px tall, and a phone opens its own picker for the select. Keyboard: Tab to the row, Enter or Space opens it; Tab to the select and choose with the arrow keys or by typing a name; Tab to Save and press Enter. Screen reader: “Time zone, Eastern, button, collapsed”; then the select, named “Time zone” and described by its muted line (and by its error).",
	motion:
		"The chevron turns a quarter turn as the row opens. Reduced motion shows the end state at once. Nothing else moves.",
	edges:
		"Only a zone the select offers is saved: a post that names another comes back with the error and changes nothing. Saving the zone that's already saved is fine. The zone changes only “today”; a transaction's own date is never converted. A saved zone the select doesn't offer still shows its city at the right, and the select starts on Eastern. At 320px the name and the zone sit side by side. No JavaScript: it's a plain details element and a form that posts.",
	words:
		"Time zone · {Eastern} (Eastern, Central, Mountain, Pacific, Alaska, Hawaii; the others by city) · Other time zones · Decides when a new month starts and when a bill is due. Transactions keep the bank's dates. · Save · Saving… · Cancel · Toast: Saved time zone · Announced: Saved time zone. Months and bills now follow {Central} time. · Error: Choose a time zone from the list.",
};

// The price-changed offer's use spec (decision 72, P36 B): every line answered before the owner signs it off.
const BILL_PRICE_SPEC: UseSpecText = {
	purpose:
		"Tell a person a payment from a bill's merchant came at another price, and let them update the bill to it or say it isn't that bill's.",
	affordance:
		"On Bills the row says “Price changed?” in ink with what was paid under it in muted words, so it reads without color, and the whole row is still the link to the bill's page. On the page the month asks in a sentence, with one primary button, “Update the bill to $17.99”, and “Not this bill” as terracotta text under it. Nothing changes until one is pressed.",
	states:
		"Shown: an active bill whose current month has no payment, and a payment from the same merchant within 5 days of its due date, money out, outside ±10% of the bill's amount, not linked to another bill and not already turned away for that month. Not shown: a payment inside ±10% (the matcher links it), a paid month, an inactive bill, a month already answered. Buttons: rest, hover, the focus-visible ring and pressed; the primary shows “Updating…” with the spinner and is disabled while it saves. Error: “That price change isn't on offer any more.” in role=alert, when the offer went away, or the bill's amount or the charge changed, after the page was drawn: Update saves only the two prices the person saw.",
	feedback:
		"Update: the page comes back with the month Paid and the new amount under the name, a toast “Bill updated to $17.99”, and the announcer says “Bill updated to $17.99 and the payment linked”. Not this bill: the month is an ordinary unpaid one again, with Link a payment; the toast says “Left the bill at $15.49” and the announcer “Price change dismissed. The bill stays $15.49.” The payment isn't offered again for that month.",
	input:
		"Touch: both actions are 44px tall. Keyboard: Tab reaches Update the bill, then Not this bill; Enter or Space presses. Screen reader: on Bills, “Netflix, Price changed?, Paid $17.99 on Oct 3, $15.49, link”; on the page, the sentence, then “Update the bill to $17.99, button” and “Not this bill, button”.",
	motion: "None added. Reduced motion changes nothing.",
	edges:
		"Two payments qualify: the closest to the due date, then the closest in amount, then the earliest. A payment over $100,000 is never offered; a bill that large is confirmed in its own form. An excluded payment can be offered, and once updated it counts in the budget as a bill payment. A refund or other money in is never offered. A long name or a phone's width: the two caption lines wrap instead of being cut off, and the row grows a line. The amount changes for the whole bill, since amount history comes with Phase 5. No JavaScript: both actions are forms that post and come back to the bill's page.",
	words:
		"Price changed? · Paid {$17.99} on {Oct 3} · {Netflix} charged {$17.99} on {Oct 3}, not {$15.49}. · Updating the bill links that payment and makes it {$17.99} a month. · Update the bill to {$17.99} · Updating… · Not this bill · Toasts: Bill updated to {$17.99} · Left the bill at {$15.49} · Error: That price change isn't on offer any more.",
};

/**
 * A picture of part of a page: HomeTop draws the page's h1 and real links, so here it's one labelled
 * image with nothing inside to Tab to, and the catalog keeps its own h1.
 */
function Picture({ label, children }: { label: string; children?: Child }) {
	return (
		<div role="img" aria-label={label} class="max-w-2xl">
			<div inert>{children}</div>
		</div>
	);
}

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });

/**
 * What a picture of Home shows, in words, built from the same data it draws, so a screen reader
 * hears the content being compared rather than only the picture's name.
 */
function describeHome({
	band = true,
	rows = true,
	bankLine,
}: {
	band?: boolean;
	rows?: boolean;
	bankLine?: string;
} = {}) {
	const parts = [
		HOME_TOP.month,
		`Safe to spend ${whole(HOME_TOP.safeToSpendCents)}`,
		HOME_TOP.status,
		"How this works",
		...(bankLine ? [bankLine, "Check Accounts"] : []),
		...(band ? [HOME_TOP.band.text, HOME_TOP.band.detail] : []),
	];
	if (rows)
		parts.push(
			`Budget: ${HOME_ROWS.map((r) => `${r.name} ${whole(r.spentCents)} of ${whole(r.budgetCents)}`).join(", ")}`,
		);
	return parts.join(". ").replaceAll("..", ".");
}

/** Home's top and the Budget list under it, as Home will draw them (#92). */
function HomeSketch({
	band = true,
	bankLine,
}: {
	band?: boolean;
	bankLine?: string;
}) {
	return (
		<>
			<HomeTop
				{...HOME_TOP}
				bankLine={bankLine}
				band={band ? HOME_TOP.band : undefined}
			/>
			<h2 class="mt-8 font-serif text-3xl font-semibold">Budget</h2>
			<ul class="mt-2 divide-y divide-rule">
				{HOME_ROWS.map((row) => (
					<ProgressRow {...row} />
				))}
			</ul>
		</>
	);
}

function HomeTopGroup() {
	return (
		<Group id="home" title="Home's top">
			<Specimen
				id="home-top"
				title="HomeTop"
				tier="visual"
				components={["HomeTop"]}
				sentence="What's safe to spend is the one thing on Home, so it's on a phone's first screen (decision 46, P1): the month as a small heading, Safe to spend, the status sentence, How this works, a BankLine when a bank has stopped syncing (its own entry, below) and the Band. Things to try moves below the Budget list. On desktop the top and the list share one width."
			>
				<State label="A phone's first screen (390×844, less the tab bar): the number is near the top">
					<PhoneFrame
						label={`Home on a phone's first screen, top to bottom: ${describeHome()}`}
					>
						<HomeSketch />
					</PhoneFrame>
				</State>
				<State label="Desktop: the top and the Budget list share one width, with no gap beside them">
					<Picture
						label={`Home on desktop, top and Budget list at one width: ${describeHome()}`}
					>
						<HomeSketch />
					</Picture>
				</State>
				<State label="Nothing needs a category: no Band">
					<Picture
						label={`Home's top when nothing needs a category, with no Band: ${describeHome({ band: false, rows: false })}`}
					>
						<HomeTop {...HOME_TOP} band={undefined} />
					</Picture>
				</State>
			</Specimen>
			<Specimen
				id="bank-line"
				title="BankLine"
				tier="visual"
				components={["BankLine"]}
				sentence="When a connected bank needs you to sign in again, or hasn't synced for 3 days, Safe to spend may be too high, so a line under the status sentence says so and links to Accounts (decision 72, P37 A). Family app only: the demo has no banks to fix."
			>
				<State label="Hasn't synced for 3 days, on the family app's phone first screen: the number stays on top, and the Band keeps its job">
					<PhoneFrame
						demo={false}
						label={`Home on a phone's first screen in the family app, top to bottom: ${describeHome({ bankLine: BANK_LINES.stale })}`}
					>
						<HomeSketch bankLine={BANK_LINES.stale} />
					</PhoneFrame>
				</State>
				<State label="Needs signing in again (also the words for a bank that hasn't synced too)">
					<Picture
						label={`Home's top with a bank that needs signing in: ${describeHome({ bankLine: BANK_LINES.signIn, rows: false })}`}
					>
						<HomeTop {...HOME_TOP} bankLine={BANK_LINES.signIn} />
					</Picture>
				</State>
				<State label="Two or more banks: it names the first and counts the rest">
					<Picture
						label={`Home's top with several banks to look at: ${describeHome({ bankLine: BANK_LINES.several, rows: false })}`}
					>
						<HomeTop {...HOME_TOP} bankLine={BANK_LINES.several} />
					</Picture>
				</State>
				<UseSpec spec={BANK_LINE_SPEC} />
			</Specimen>
		</Group>
	);
}

function Rows() {
	return (
		<Group id="rows" title="Rows">
			<Specimen
				id="bill-occurrence"
				title="Bill occurrence and payment picker"
				tier="visual"
				components={["BillOccurrenceRow", "BillPaymentPicker"]}
				sentence="A bill page shows paid, due, upcoming and not-paid occurrences, asks whether to update the bill when a payment came at another price, and offers eligible payments in an inert picker."
			>
				<State label="Paid occurrence">
					<div inert>
						<ul>
							<BillOccurrenceRow
								billId={1}
								period="2026-09"
								label="September 2026"
								status="paid"
								payment={{
									displayName: "City Electric",
									dateLabel: "Sep 24",
									amountCents: 14200,
									matchedBy: "auto",
								}}
							/>
						</ul>
					</div>
				</State>
				<State label="Unpaid occurrence">
					<div inert>
						<ul>
							<BillOccurrenceRow
								billId={1}
								period="2026-10"
								label="October 2026"
								status="due"
							/>
						</ul>
					</div>
				</State>
				<State label="Price changed? (the newest month asks)">
					<div inert>
						<ul>
							<BillOccurrenceRow
								billId={1}
								period="2026-10"
								label="October"
								status="overdue"
								priceOffer={{
									transactionId: 7,
									merchant: "Netflix",
									amountCents: 1799,
									dateLabel: "Oct 3",
									billAmountCents: 1549,
									frequency: "monthly",
								}}
							/>
						</ul>
					</div>
				</State>
				<State label="Picker">
					<div inert>
						<BillPaymentPicker
							billId={1}
							billName="Electric"
							billAmountCents={14200}
							openedPeriod="2026-09"
							dueDateLabel="Sep 24"
							candidates={[
								{
									id: 1,
									displayName: "City Electric",
									date: "2026-09-24",
									dateLabel: "Sep 24",
									amountCents: 14150,
								},
								{
									id: 2,
									displayName: "Zelle",
									date: "2026-09-23",
									dateLabel: "Sep 23",
									amountCents: 14200,
									excluded: true,
								},
							]}
							periods={[
								{
									value: "2026-09",
									label: "September",
									countedMonth: "2026-09",
								},
								{ value: "2026-10", label: "October", countedMonth: "2026-10" },
							]}
						/>
					</div>
				</State>
				<State label="Empty picker">
					<div inert>
						<BillPaymentPicker
							billId={1}
							billName="Electric"
							billAmountCents={14200}
							openedPeriod="2026-09"
							dueDateLabel="Sep 24"
							candidates={[]}
							periods={[
								{
									value: "2026-09",
									label: "September",
									countedMonth: "2026-09",
								},
							]}
						/>
					</div>
				</State>
				<UseSpec spec={BILL_PRICE_SPEC} />
			</Specimen>
			<Specimen
				id="bill-row"
				title="BillRow and bill status heading"
				tier="visual"
				components={["BillRow", "BillStatusHeading"]}
				sentence="A bill group names its status with an icon and words; each bill shows its category, name, status sentence and amount, and asks “Price changed?” when a payment came at another price."
			>
				<State label="Overdue">
					<div class="max-w-xl">
						<BillStatusHeading status="overdue" />
						<ul>
							<BillRow
								today="2026-10-04"
								bill={{
									id: 1,
									name: "Electric",
									amountCents: 14200,
									status: "overdue",
									dueDate: "2026-09-24",
									icon: "household",
									color: "cat-brown",
								}}
							/>
						</ul>
					</div>
				</State>
				<State label="Overdue, price changed? (P36 B)">
					<div class="max-w-xl">
						<BillStatusHeading status="overdue" />
						<ul>
							<BillRow
								today="2026-10-05"
								bill={{
									id: 6,
									name: "Netflix",
									amountCents: 1549,
									status: "overdue",
									dueDate: "2026-10-02",
									priceOffer: { amountCents: 1799, date: "2026-10-03" },
									icon: "household",
									color: "cat-brown",
								}}
							/>
						</ul>
					</div>
				</State>
				<State label="Due">
					<div class="max-w-xl">
						<BillStatusHeading status="due" />
						<ul>
							<BillRow
								today="2026-10-04"
								bill={{
									id: 3,
									name: "Rent",
									amountCents: 185000,
									status: "due",
									dueDate: "2026-10-05",
									icon: "household",
									color: "cat-brown",
								}}
							/>
						</ul>
					</div>
				</State>
				<State label="Upcoming, linked row">
					<div class="max-w-xl">
						<BillStatusHeading status="upcoming" />
						<ul>
							<BillRow
								href="#bill-row"
								today="2026-10-04"
								bill={{
									id: 4,
									name: "Car insurance",
									amountCents: 11840,
									status: "upcoming",
									dueDate: "2026-11-15",
									icon: "gas",
									color: "cat-slate",
								}}
							/>
						</ul>
					</div>
				</State>
				<State label="Paid">
					<div class="max-w-xl">
						<BillStatusHeading status="paid" />
						<ul>
							<BillRow
								today="2026-10-04"
								bill={{
									id: 5,
									name: "Streaming",
									amountCents: 299,
									status: "paid",
									dueDate: "2026-10-02",
									paidDate: "2026-10-02",
									icon: "household",
									color: "cat-blue",
								}}
							/>
						</ul>
					</div>
				</State>
				<State label="Paid late">
					<div class="max-w-xl">
						<BillStatusHeading status="paid" />
						<ul>
							<BillRow
								today="2026-10-04"
								bill={{
									id: 2,
									name: "Water",
									amountCents: 4820,
									status: "paid",
									dueDate: "2026-09-20",
									paidDate: "2026-09-23",
									icon: "household",
									color: "cat-blue",
								}}
							/>
						</ul>
					</div>
				</State>
			</Specimen>
			<Specimen
				id="bill-finding"
				title="Bill finding Band and review row"
				tier="visual"
				components={["BillFindingBand", "BillFindingRow"]}
				sentence="The Band points to repeat charges worth reviewing; each row lets a person add or permanently dismiss one suggestion."
			>
				<State label="Band">
					<div inert class="max-w-xl">
						<BillFindingBand count={3} />
					</div>
				</State>
				<State label="Review row">
					<ul inert class="max-w-xl">
						<BillFindingRow
							suggestion={{
								rawName: "CITY GYM",
								displayName: "City Gym",
								amountCents: 4250,
								dueDay: 12,
								categoryId: 4,
								chargeCount: 3,
							}}
						/>
					</ul>
				</State>
			</Specimen>
			<Specimen
				id="progress-row"
				title="ProgressRow"
				tier="visual"
				components={["ProgressRow"]}
				sentence="One category: icon, name, “spent of budget,” and a 4px bar with no limit marker (decision 46); over budget, the bar is full and brick, with an alert icon and how much it's over in words (“$36 over”). In the app each row opens its budget sheet; here they don't link anywhere."
			>
				{PROGRESS_ROWS.map((s) => (
					<State label={s.label}>
						<ul class="max-w-xl">
							<ProgressRow {...s.props} />
						</ul>
					</State>
				))}
			</Specimen>
			<Specimen
				id="adjust-mode"
				title="Adjust mode: AdjustLink and ProgressRow's − and +"
				tier="visual"
				components={["AdjustLink"]}
				sentence="Home's budget list with − and + on every budgeted row, so a budget moves to the next round $10 where it's seen (decision 48). “Adjust” beside the Budget heading turns it on, and “Done” puts it away. Here nothing posts; on Home each tap saves."
			>
				<State label="Day to day">
					<BudgetHeading adjusting={false} />
					<ul class="max-w-xl divide-y divide-rule">
						{ADJUST_ROWS.map(({ nudge: _, ...row }) => (
							<ProgressRow {...row} />
						))}
					</ul>
				</State>
				<State label="Adjusting: a round amount, one between round $10s, over budget, $0 (− is off) and the largest budget (+ is off). Each row opens the sheet page">
					<BudgetHeading adjusting={true} />
					<ul class="max-w-xl divide-y divide-rule">
						{ADJUST_ROWS.map((row) => (
							<ProgressRow {...row} />
						))}
					</ul>
				</State>
				<UseSpec spec={ADJUST_SPEC} />
			</Specimen>
			<Specimen
				id="transaction-row"
				title="TransactionRow"
				tier="visual"
				components={["TransactionRow"]}
				sentence="One transaction as a single link to its edit panel: icon, name, category or status in words, signed amount. A pending one adds “Pending” to the same caption line in muted words, with no new tag or color (P34 A, decision 72). A name Tally guessed has the sparkles icon before it and a dashed underline until a person chooses it (P29 A, P87 B, decisions 64 and 80). Here the rows don't link anywhere."
			>
				<State label="Above the list, once only while a suggested name is shown">
					<div class="max-w-xl">
						<p class="flex flex-wrap items-center gap-x-1 text-sm text-muted">
							Dashed names are suggestions.
							<WhyLink section="names" topic="suggested name" />
						</p>
						<ul class="max-w-xl">
							{TRANSACTION_ROWS.filter((state) => state.row.nameSuggested)
								.slice(0, 1)
								.map((state) => (
									<TransactionRow row={state.row} />
								))}
						</ul>
					</div>
				</State>
				{TRANSACTION_ROWS.map((s) => (
					<State label={s.label}>
						<ul class="max-w-xl">
							<TransactionRow row={s.row} />
						</ul>
					</State>
				))}
			</Specimen>
			<Specimen
				id="pending-note"
				title="PendingNote"
				tier="visual"
				components={["PendingNote"]}
				sentence="The muted line under a pending transaction's date in its edit panel: a clock and what pending means (P34 A, decision 72)."
			>
				<State label="Under the date, in the edit panel">
					<div class="flex max-w-xl flex-col gap-1">
						<p class="text-muted">Today, Oct 5 · Everyday Checking ••1234</p>
						<PendingNote />
					</div>
				</State>
			</Specimen>
			<Specimen
				id="selectable-transaction-row"
				title="SelectableTransactionRow"
				tier="visual"
				components={["SelectableTransactionRow"]}
				sentence="One transaction in select mode is a large label whose round checkbox takes keyboard focus and gains the checked Chip look."
			>
				<State label="Available to select">
					<ul class="max-w-xl">
						{TRANSACTION_ROWS.slice(0, 1).map((state) => (
							<SelectableTransactionRow row={state.row} />
						))}
					</ul>
				</State>
				<State label="Selected">
					<ul class="max-w-xl">
						{TRANSACTION_ROWS.slice(1, 2).map((state) => (
							<SelectableTransactionRow row={state.row} checked />
						))}
					</ul>
				</State>
			</Specimen>
			<Specimen
				id="empty-state"
				title="EmptyState"
				tier="visual"
				components={["EmptyState"]}
				sentence="Where a list would be when it is empty: a small drawing, one sentence, a muted hint and at most one button, centred. A magnifier means no results, a tick nothing to do, and an add sign one thing to start, where the screen's own button goes (decision 55)."
			>
				<div class="grid gap-6 lg:grid-cols-2">
					<State label="No results: one thing to do">
						<EmptyState
							kind="search"
							sentence="No transactions match these filters."
							hint="Try a wider month, or clear the search."
							action={{ href: "/transactions", label: "Clear filters" }}
						/>
					</State>
					<State label="Nothing to do: no button">
						<EmptyState
							kind="done"
							sentence="Every transaction has a category."
							hint="New ones appear here as they come in."
						/>
					</State>
					<State label="One thing to start: the screen's own button (decision 55)">
						<EmptyState
							kind="add"
							sentence="No banks linked yet."
							hint="Link your bank to see balances and net worth here. Tally can only read them; it can't move money."
						>
							<Button type="button">Link a bank</Button>
						</EmptyState>
					</State>
				</div>
			</Specimen>
			<Specimen
				id="band"
				title="Band"
				tier="visual"
				components={["Band"]}
				sentence="The one tinted row per screen that links to the thing to do next, with an optional quiet second line. Both open the demo's real list of transactions that need a category."
			>
				<State label="One line">
					<div class="max-w-xl">
						<Band href={BAND.href}>{BAND.text}</Band>
					</div>
				</State>
				<State label="With a second line, as on Home (decision 50)">
					<div class="max-w-xl">
						<Band href={BAND.href} detail={HOME_TOP.band.detail}>
							{BAND.text}
						</Band>
					</div>
				</State>
			</Specimen>
		</Group>
	);
}

const BUTTON_SPEC: UseSpecText = {
	purpose:
		"Do the main action, a secondary alternative, or a quiet text action.",
	affordance:
		"A filled, outlined, or terracotta label looks actionable without hover.",
	states:
		"Rest, focus, disabled, and loading apply; hover and pressed use the browser defaults. Loading disables submit actions and swaps their label for a spinner and action-specific word; the button may grow to fit it, and done and error appear in the result.",
	feedback:
		"A form action immediately shows its busy label and cannot be submitted twice; then the destination or result appears, focus follows changed content, and HTMX announces the result.",
	input:
		"Every target is at least 44px; Tab focuses it, Enter or Space activates a button, and a screen reader announces its name, role, and disabled state.",
	motion:
		"The loading ring spins until the request ends; with reduced motion it stays still while the busy words remain visible.",
	edges:
		"Long labels may wrap, and a longer loading label may make the button grow during the request. A slow request stays disabled and busy; without JavaScript the form submits normally and no busy label shows.",
	words:
		"Use a short verb phrase such as Save, Cancel, Archive, Restore, or Add category. Place one primary button per screen or sheet, at the end of the form, with Cancel beside it.",
};

const TEXT_INPUT_SPEC: UseSpecText = {
	purpose: "Enter or change one short piece of text.",
	affordance:
		"A labeled bordered field shows where to type without relying on hover.",
	states:
		"Rest, focus, filled, error, and disabled apply; error shakes once when returned, while hover, pressed, loading, and done are not separate field states.",
	feedback:
		"Typing appears immediately; validation shakes the invalid field once, shows an error below it, and a screen reader hears the error as an alert.",
	input:
		"The field is at least 44px high; tap or Tab focuses it, typing edits it, and a screen reader announces its label, value, and invalid or disabled state.",
	motion:
		"An invalid field shakes horizontally once for 300ms; with reduced motion it does not move and the error still appears.",
	edges:
		"Empty and long values use validation and the length limit; a disabled field cannot be edited; without JavaScript the form submits normally, errors still read clearly, and no busy label shows.",
	words:
		"The visible label names the value; errors say what to do, for example Give the category a name.",
};

function Controls() {
	return (
		<Group id="controls" title="Controls">
			<Specimen
				id="button"
				title="Button"
				tier="visual"
				components={["Button"]}
				sentence="A primary, secondary, or quiet text action, rendered as a button or link."
			>
				<div class="flex flex-wrap gap-3">
					{(["primary", "secondary", "text"] as const).map((kind) => (
						<>
							<State label={`${kind}, rest`}>
								<Button kind={kind} type="button">
									{kind === "primary"
										? "Save"
										: kind === "secondary"
											? "Cancel"
											: "Archive"}
								</Button>
							</State>
							<State label={`${kind}, disabled`}>
								<Button kind={kind} type="button" disabled>
									{kind === "primary"
										? "Save"
										: kind === "secondary"
											? "Cancel"
											: "Archive"}
								</Button>
							</State>
						</>
					))}
				</div>
				<State label="primary, busy">
					<div class="htmx-request">
						<Button type="button" busyLabel="Saving…">
							Save
						</Button>
					</div>
				</State>
				<UseSpec spec={BUTTON_SPEC} />
			</Specimen>
			<Specimen
				id="text-input"
				title="TextInput"
				tier="visual"
				components={["TextInput"]}
				sentence="A labeled single-line text field with accessible error and disabled states."
			>
				<div class="grid gap-4 sm:grid-cols-2">
					<State label="Rest">
						<TextInput id="ds-input-rest" label="Name" name="rest" />
					</State>
					<State label="Filled">
						<TextInput
							id="ds-input-filled"
							label="Name"
							name="filled"
							value="Groceries"
						/>
					</State>
					<State label="Error">
						<TextInput
							id="ds-input-error"
							label="Name"
							name="error"
							error="Give the category a name."
						/>
					</State>
					<State label="Disabled">
						<TextInput
							id="ds-input-disabled"
							label="Name"
							name="disabled"
							value="Groceries"
							disabled
						/>
					</State>
				</div>
				<UseSpec spec={TEXT_INPUT_SPEC} />
			</Specimen>
			<Specimen
				id="chip"
				title="Chip"
				tier="interactive"
				components={["Chip"]}
				sentence="A pill-shaped checkbox or radio; the real input is visually hidden but keyboard-reachable. A checkbox chip shows a check mark while on, so its state isn't color alone."
			>
				<fieldset>
					<legend class="text-sm font-medium text-muted">
						Radio chips: pick one (arrow keys move)
					</legend>
					<div class="mt-2 flex flex-wrap gap-2">
						<Chip
							type="radio"
							name="ds-category"
							value="groceries"
							checked
							icon={<CategoryIcon icon="groceries" color="cat-blue" />}
						>
							Groceries
						</Chip>
						<Chip
							type="radio"
							name="ds-category"
							value="eating-out"
							icon={<CategoryIcon icon="eating-out" color="cat-plum" />}
						>
							Eating out
						</Chip>
						<Chip
							type="radio"
							name="ds-category"
							value="gas"
							icon={<CategoryIcon icon="gas" color="cat-slate" />}
						>
							Gas
						</Chip>
					</div>
				</fieldset>
				<fieldset>
					<legend class="text-sm font-medium text-muted">
						Checkbox chips: toggles, on and off
					</legend>
					<div class="mt-2 flex flex-wrap gap-2">
						<Chip type="checkbox" name="ds-always" value="1" checked>
							Always for this merchant
						</Chip>
						<Chip type="checkbox" name="ds-exclude" value="1">
							Exclude from budget
						</Chip>
					</div>
				</fieldset>
				<fieldset>
					<legend class="text-sm font-medium text-muted">
						A checkbox chip that answers an alert: unticked, tied to the alert
						line, then ticked, with the line gone (a bill over $100,000)
					</legend>
					<div class="mt-2 flex flex-col gap-2">
						<p id="ds-confirm-alert" role="alert" class="text-sm text-over">
							$150,000.00 is a lot for a bill.
						</p>
						<div class="flex flex-wrap gap-2">
							<Chip
								type="checkbox"
								name="ds-confirm"
								value="15000000"
								describedBy="ds-confirm-alert"
							>
								Yes, $150,000.00 is right
							</Chip>
							<Chip
								type="checkbox"
								name="ds-confirmed"
								value="15000000"
								checked
							>
								Yes, $150,000.00 is right
							</Chip>
						</div>
					</div>
				</fieldset>
				<fieldset disabled>
					<legend class="text-sm font-medium text-muted">
						Disabled: a refund linked to a purchase counts in its purchase's
						category
					</legend>
					<div class="mt-2 flex flex-wrap gap-2">
						<Chip
							type="radio"
							name="ds-category-disabled"
							value="groceries"
							checked
							icon={<CategoryIcon icon="groceries" color="cat-blue" />}
						>
							Groceries
						</Chip>
						<Chip
							type="radio"
							name="ds-category-disabled"
							value="gas"
							icon={<CategoryIcon icon="gas" color="cat-slate" />}
						>
							Gas
						</Chip>
					</div>
				</fieldset>
			</Specimen>
			<Specimen
				id="filter-select"
				title="FilterSelect"
				tier="interactive"
				components={["FilterSelect"]}
				sentence="A pill-shaped choice that narrows a list: Transactions' Month, Category, Account and Show (P63 A, P64 B). A real select with a label only a screen reader hears."
			>
				<State label="Transactions' filter bar at rest: Month, Category, Account and Show (the selects open here; only Transactions filters a list)">
					<div class="flex max-w-3xl flex-wrap gap-2">
						<FilterSelect
							id="ds-filter-month"
							name="ds-month"
							label="Month"
							options={[
								{ value: "2026-10", label: "October" },
								{ value: "2026-09", label: "September" },
								{ value: "all", label: "All months" },
							]}
							selected="2026-10"
						/>
						<FilterSelect
							id="ds-filter-category"
							name="ds-category"
							label="Category"
							options={[
								{ value: "", label: "All categories" },
								{ value: 1, label: "Groceries" },
								{ value: 2, label: "Eating Out" },
							]}
							selected={null}
						/>
						<FilterSelect
							id="ds-filter-account"
							name="ds-account"
							label="Account"
							options={[
								{ value: "", label: "All accounts" },
								{ value: 3, label: "Chase Card ••9921" },
								{ value: 5, label: "Old Savings ••3340 · Disconnected" },
								{ value: 4, label: "Cash" },
							]}
							selected={null}
						/>
						<FilterSelect
							id="ds-filter-show"
							name="ds-show"
							label="Show"
							options={[
								{ value: "all", label: "All" },
								{ value: "spending", label: "Spending" },
								{ value: "income", label: "Income" },
								{ value: "refunds", label: "Refunds" },
								{ value: "excluded", label: "Excluded" },
							]}
							selected="all"
						/>
					</div>
				</State>
				<State label="With choices made: a category, an account and Show Income">
					<div class="flex max-w-3xl flex-wrap gap-2">
						<FilterSelect
							id="ds-filter-month-set"
							name="ds-month-set"
							label="Month"
							options={[
								{ value: "2026-10", label: "October" },
								{ value: "all", label: "All months" },
							]}
							selected="all"
						/>
						<FilterSelect
							id="ds-filter-category-set"
							name="ds-category-set"
							label="Category"
							options={[
								{ value: "", label: "All categories" },
								{ value: 1, label: "Groceries" },
							]}
							selected={1}
						/>
						<FilterSelect
							id="ds-filter-account-set"
							name="ds-account-set"
							label="Account"
							options={[
								{ value: "", label: "All accounts" },
								{ value: 3, label: "Chase Card ••9921" },
							]}
							selected={3}
						/>
						<FilterSelect
							id="ds-filter-show-set"
							name="ds-show-set"
							label="Show"
							options={[
								{ value: "all", label: "All" },
								{ value: "income", label: "Income" },
							]}
							selected="income"
						/>
					</div>
				</State>
				<State label="On a narrow phone (320px): a long account name shortens inside its pill and the pills wrap">
					<div class="flex w-[320px] max-w-full flex-wrap gap-2">
						<FilterSelect
							id="ds-filter-month-narrow"
							name="ds-month-narrow"
							label="Month"
							options={[{ value: "2026-10", label: "October" }]}
							selected="2026-10"
						/>
						<FilterSelect
							id="ds-filter-account-narrow"
							name="ds-account-narrow"
							label="Account"
							options={[
								{
									value: 3,
									label: "Chase Sapphire Preferred Rewards Credit Card ••9921",
								},
							]}
							selected={3}
						/>
					</div>
				</State>
				<UseSpec spec={FILTER_SELECT_SPEC} />
			</Specimen>
			<Specimen
				id="view-links"
				title="ViewLinks"
				tier="visual"
				components={["ViewLinks"]}
				sentence="The demo's “See it without AI” (decisions 73 and 79, P44 A): two plain links under the Transactions title, “Tidied by Tally · Straight from the bank”, that switch the list between what Tally made of it and the bank's own data. The current one is ink and semibold; the other is a terracotta link. They are real links to the demo's Transactions."
			>
				<State label="Tally's list: “Tidied by Tally” is current">
					<ViewLinks
						id="ds-view-made"
						current="made"
						madeHref="/transactions"
						bankHref="/transactions?raw=1"
					/>
				</State>
				<State label="The bank's list (?raw=1): “Straight from the bank” is current">
					<ViewLinks
						id="ds-view-bank"
						current="bank"
						madeHref="/transactions"
						bankHref="/transactions?raw=1"
					/>
				</State>
				<State label="On a narrow phone (320px): both links still fit on one line">
					<div class="w-[320px] max-w-full">
						<ViewLinks
							id="ds-view-narrow"
							current="bank"
							madeHref="/transactions"
							bankHref="/transactions?raw=1"
						/>
					</div>
				</State>
				<UseSpec spec={VIEW_LINKS_SPEC} />
			</Specimen>
			<Specimen
				id="switch"
				title="Switch"
				tier="interactive"
				components={["Switch"]}
				sentence="A real checkbox drawn as a switch, with On or Off in words beside it (decision 73, P41 B). It works without JavaScript, and its whole 44px row is the target."
			>
				<State label="Off, on, and with no muted line (tap one: it turns here as it does in Settings)">
					<ul class="max-w-xl divide-y divide-rule border-y border-rule">
						<li>
							<Switch
								id="ds-switch-off"
								name="ds-switch-off"
								label="Income"
								hint="Spots paychecks and other money coming in."
							/>
						</li>
						<li>
							<Switch
								id="ds-switch-on"
								name="ds-switch-on"
								label="Categories and exclusions"
								hint="Picks categories, and leaves out transfers and reimbursements."
								checked
							/>
						</li>
						<li>
							<Switch
								id="ds-switch-plain"
								name="ds-switch-plain"
								label="Income"
								checked
							/>
						</li>
					</ul>
				</State>
				<State label="Greyed out (it needs another switch on): still shows its saved On or Off, says what it needs, and can't be turned">
					<ul class="max-w-xl divide-y divide-rule border-y border-rule">
						<li>
							<Switch
								id="ds-switch-greyed-on"
								name="ds-switch-greyed-on"
								label="Sort new transactions as they arrive"
								hint="Sorts them right after each sync, not only overnight."
								checked
								disabled
								note="Needs Categories and exclusions or Income on."
							/>
						</li>
						<li>
							<Switch
								id="ds-switch-greyed-off"
								name="ds-switch-greyed-off"
								label="Sort new transactions as they arrive"
								hint="Sorts them right after each sync, not only overnight."
								disabled
								note="Needs Categories and exclusions or Income on."
							/>
						</li>
					</ul>
				</State>
				<State label="On a narrow phone (320px): the name wraps, and the word and the track keep their place">
					<div class="w-[320px] max-w-full border-y border-rule">
						<Switch
							id="ds-switch-narrow"
							name="ds-switch-narrow"
							label="Categories and exclusions"
							hint="Picks categories, and leaves out transfers and reimbursements."
							checked
						/>
					</div>
				</State>
				<UseSpec spec={SWITCH_SPEC} />
			</Specimen>
			<Specimen
				id="name-choices"
				title="NameChoices"
				tier="interactive"
				components={["NameChoices"]}
				sentence="Choosing what a merchant is called when there are names for it (P29 A, decision 64): the guesses, with where they came from under them (P87 B, decision 80: “Tally's guess”, or “From your bank” for the name the bank sent), keeping the bank's tidied text, or a name of your own. Nothing is chosen to start with, so nothing is renamed until a person decides."
			>
				<State label="Three guesses waiting: nothing chosen yet (tap one: it fills as it does in the edit panel)">
					<div class="max-w-xl">
						<NameChoices
							id="ds-names-three"
							radioName="ds-names-three"
							names={["Blue Bottle Coffee", "Blue Bottle", "Blue Bottle Cafe"]}
							source="tally"
							tidied="Blue bottle cof"
							count={9}
						/>
					</div>
				</State>
				<State label="One guess, for one transaction, with it chosen">
					<div class="max-w-xl">
						<NameChoices
							id="ds-names-one"
							radioName="ds-names-one"
							names={["DoorDash"]}
							source="tally"
							tidied="Doordash taco"
							count={1}
							picked={pickValue("DoorDash")}
						/>
					</div>
				</State>
				<State label="A name the bank sent: “From your bank” in muted words, no icon and no Why?">
					<div class="max-w-xl">
						<NameChoices
							id="ds-names-bank"
							radioName="ds-names-bank"
							names={["Blue Bottle Coffee"]}
							source="bank"
							tidied="Blue bottle cof"
							count={9}
						/>
					</div>
				</State>
				<State label="Nothing chosen, field empty, and the choice error under it">
					<div class="max-w-xl">
						<NameChoices
							id="ds-names-error"
							radioName="ds-names-error"
							names={["Craft Supply Co", "Craft Supply"]}
							source="tally"
							tidied="Craftsupply"
							count={2}
							error="Pick a name, keep the bank's, or type your own."
						/>
					</div>
				</State>
				<State label="On a narrow phone (320px): long names wrap inside their chips">
					<div class="w-[320px] max-w-full">
						<NameChoices
							id="ds-names-narrow"
							radioName="ds-names-narrow"
							names={[
								"A very long guessed store name for the neighborhood market",
							]}
							source="tally"
							tidied="A very long tidied name the bank sent for a neighborhood market"
							count={9}
						/>
						<NameChoices
							id="ds-names-unbroken"
							radioName="ds-names-unbroken"
							names={["The Store"]}
							source="bank"
							tidied="https://example.com/this-is-a-long-unbroken-name-for-the-bank"
							count={1}
						/>
					</div>
				</State>
				<UseSpec spec={NAME_CHOICES_SPEC} />
			</Specimen>
			<Specimen
				id="time-zone-row"
				title="TimeZoneRow"
				tier="visual"
				components={["TimeZoneRow"]}
				sentence="Settings' Household row (decision 72, P35 A): “Time zone” with the zone's everyday name at the right and a chevron, which opens to a select and Save. It works without JavaScript."
			>
				<State label="Closed, as Settings draws it">
					<div inert class="max-w-3xl border-t border-rule">
						<TimeZoneRow
							id="ds-zone-closed"
							zone="America/New_York"
							action="#"
							back="#"
							backSwap="#"
						/>
					</div>
				</State>
				<State label="Open: the select, what the zone decides, and Save and Cancel">
					<div inert class="max-w-3xl border-t border-rule">
						<TimeZoneRow
							id="ds-zone-open"
							zone="America/Chicago"
							open
							action="#"
							back="#"
							backSwap="#"
						/>
					</div>
				</State>
				<State label="With an error: the row opens, and the words sit under the select in role=“alert”">
					<div inert class="max-w-3xl border-t border-rule">
						<TimeZoneRow
							id="ds-zone-error"
							zone="America/Chicago"
							error="Choose a time zone from the list."
							action="#"
							back="#"
							backSwap="#"
						/>
					</div>
				</State>
				<State label="On a narrow phone (320px), with a longer name">
					<div inert class="w-[320px] max-w-full border-t border-rule">
						<TimeZoneRow
							id="ds-zone-narrow"
							zone="America/Puerto_Rico"
							action="#"
							back="#"
							backSwap="#"
						/>
					</div>
				</State>
				<UseSpec spec={TIME_ZONE_SPEC} />
			</Specimen>
			<Specimen
				id="form-field"
				title="FormField"
				tier="visual"
				components={["FormField"]}
				sentence="A labeled control, with its error shown in role=“alert”."
			>
				{[
					["Default", "ds-name", "Groceries", undefined],
					["With an error", "ds-name-error", "", "Give the category a name."],
				].map(([label, id, value, error]) => (
					<State label={label as string}>
						<TextInput
							id={id as string}
							label="Name"
							value={value}
							autocomplete="off"
							error={error}
							class="sm:max-w-sm"
						/>
					</State>
				))}
			</Specimen>
			<Specimen
				id="cash-form"
				title="Add cash"
				tier="visual"
				components={["CashForm"]}
				sentence="P21's secondary button and edit-panel-shaped form add cash spending."
			>
				<div
					inert
					class="max-w-3xl rounded-sheet border border-rule bg-paper p-5"
				>
					<Button kind="secondary" type="button" class="gap-2">
						<Icon name="plus" class="size-5" />
						Add cash
					</Button>
					<h4 class="mt-6 font-serif text-4xl font-semibold">
						Add cash spending
					</h4>
					<CashForm
						today="2026-09-29"
						values={{
							date: "2026-09-29",
							amount: "20.00",
							merchant: "Farmers market",
							category: "1",
							note: "Peaches and eggs",
						}}
						categories={[
							{
								id: 1,
								name: "Groceries",
								icon: "groceries",
								color: "cat-blue",
							},
							{
								id: 2,
								name: "Eating Out",
								icon: "eating-out",
								color: "cat-plum",
							},
						]}
						action="#"
					/>
				</div>
			</Specimen>
			<Specimen
				id="split-form"
				title="SplitForm"
				tier="visual"
				components={["SplitForm"]}
				sentence="Category and amount parts with a live, worded line that says what remains or confirms the total."
			>
				<div inert>
					<SplitForm
						id={1}
						parentCents={18742}
						categories={[
							{ id: 1, name: "Groceries" },
							{ id: 5, name: "Household" },
						]}
						values={[
							{ category: "1", amount: "150.00" },
							{ category: "5", amount: "12.00" },
						]}
						back="/transactions"
					/>
				</div>
			</Specimen>
			<Specimen
				id="money-input"
				title="MoneyInput"
				tier="interactive"
				components={["MoneyInput"]}
				sentence="The owner's hero amount from the original app: ±$1 round buttons, ▲▼ cent arrows inside the field, Round-to and Last-month chips. Try the buttons, the chips and the ↑ ↓ keys."
			>
				{MONEY_STATES.map((s) => (
					<State label={s.label}>
						<MoneyInput {...s.props} />
					</State>
				))}
			</Specimen>
		</Group>
	);
}

function Feedback() {
	return (
		<Group id="feedback" title="Feedback and sheets">
			<Specimen
				id="feedback-button"
				title="FeedbackButton"
				tier="visual"
				components={["FeedbackButton"]}
				sentence="A fixed, shadowless pill links to the feedback form, which records the page it came from."
			>
				<p class="text-muted">
					The real component is fixed at the bottom-right of this catalog page;
					this specimen is shown in place.
				</p>
				{/* Only a picture here: the working button is the fixed one. */}
				<div inert>
					<FeedbackButton fixed={false} />
				</div>
			</Specimen>
			<Specimen
				id="feedback-form"
				title="FeedbackForm"
				tier="visual"
				components={["FeedbackForm"]}
				sentence="New feedback stores a random one-hour limiter token, report details and submission time in Cloudflare D1; it does not store the verified sign-in email. Private GitHub filing omits the token and submission time. Replay is absent, and the layout preview is hard-disabled."
			>
				{/* Only the form is inert: its title and sentence stay readable to screen readers. */}
				<div inert>
					<FeedbackForm
						diagnosticsEnabled
						values={{ type: "Bug", feeling: "Okay", message: "", from: "/" }}
					/>
				</div>
			</Specimen>
			<Specimen
				id="toast"
				title="Toast"
				tier="interactive"
				sentence="After an HTMX change the server sends HX-Trigger with toast and announce; toast.js shows the message for four seconds, fading in and out, and the announcer reads it. An error toast speaks as an alert and leads with the alert icon in the over token, so it is never colour alone; the same toast appears, over an open sheet too, when a request fails (the connection drops or the server sends a 500). These buttons send the same events."
			>
				<div class="flex flex-wrap gap-3">
					<Button
						type="button"
						kind="secondary"
						data-ds-toast="success"
						data-ds-message="Saved Groceries' budget."
					>
						Show a saved toast
					</Button>
					<Button
						type="button"
						kind="secondary"
						data-ds-toast="error"
						data-ds-message="Couldn't save. Check your connection and try again."
					>
						Show an error toast
					</Button>
				</div>
				<UseSpec spec={TOAST_SPEC} />
			</Specimen>
			<Specimen
				id="error-pages"
				title="ErrorPage"
				tier="visual"
				components={["ErrorPage"]}
				sentence="The app's own 404 and 500 pages (decision 72, P39 C), drawn inside the Layout so the navigation is there and nobody is stuck: the ledger drawing large, a serif number, one sentence and a way back. The 500 never shows what failed."
			>
				<div class="grid gap-6 lg:grid-cols-2">
					<State label="404: a link that goes nowhere. Go to Home is the way back.">
						<Picture label="The 404 page: the ledger drawing, 404, This page isn't here. and a Go to Home button.">
							<ErrorPage kind="404" />
						</Picture>
					</State>
					<State label="500: a mistake on Tally's side. Try again retries a failed page on its address, or a failed form post on the page the form was on.">
						<Picture label="The 500 page: the ledger drawing, 500, Something went wrong on our side. Nothing you did. Your data is safe; try again in a minute. and the buttons Try again and Go to Home.">
							<ErrorPage kind="500" retryHref="#error-pages" />
						</Picture>
					</State>
					<State label="500 with no page to retry: a form post that sent no usable Referer. Go to Home is the one button.">
						<Picture label="The 500 page with no Try again: the ledger drawing, 500, Something went wrong on our side. Nothing you did. Your data is safe; try again in a minute. and a Go to Home button.">
							<ErrorPage kind="500" />
						</Picture>
					</State>
				</div>
				<p class="max-w-prose text-muted">
					An htmx request that gets a 404 or a 500 swaps nothing in: the page
					stays as it was, so an open sheet stays open with what was typed. The
					404 says "This page isn't here." in the error toast; the 500 says, in
					the same toast, "Couldn't save. Check your connection and try again."
					(or "Couldn't load…" when the request was a GET, such as a filter or
					opening a sheet). A dropped connection says the same.
				</p>
			</Specimen>
			<Specimen
				id="bottom-sheet"
				title="BottomSheet"
				tier="visual"
				components={["BottomSheet"]}
				sentence="A page region over the list (bottom sheet on phones, right-hand panel on desktop) with a dimmed backdrop; not a modal, closed by Cancel or the backdrop."
			>
				<p>
					It covers the page, so it has a page of its own:{" "}
					<a
						href="/design-system/bottom-sheet"
						class="inline-flex min-h-11 items-center"
					>
						see the bottom sheet
					</a>
					. Opening it plays its motion: it rises from the bottom on a phone and
					slides in from the right at desktop width, its backdrop fading in.
				</p>
				<UseSpec spec={BOTTOM_SHEET_SPEC} />
			</Specimen>
		</Group>
	);
}

function Demo() {
	return (
		<Group id="demo" title="Guidance">
			<Specimen
				id="things-to-try"
				title="ThingsToTry"
				tier="visual"
				components={["ThingsToTry"]}
				sentence="The demo's bordered “New here? Things to try” block, below Home's Budget list until onboarding (#95) replaces it: three links to where each thing is done, plus How Tally works."
			>
				<ThingsToTry />
			</Specimen>
			<Specimen
				id="how-link"
				title="HowLink"
				tier="visual"
				components={["HowLink"]}
				sentence="A small “How this works” link under a screen's title, or under its status sentence on Home and Bills, to its section of How Tally works in both environments."
			>
				<HowLink section="budget" />
			</Specimen>
			<Specimen
				id="why-link"
				title="WhyLink"
				tier="visual"
				components={["WhyLink"]}
				sentence="A small terracotta “Why?” link beside a label goes to the exact section that explains the rule, with a distinct accessible name and a 44px target."
			>
				<p class="flex items-center gap-2">
					Going well <span aria-hidden="true">·</span>{" "}
					<WhyLink section="trends" topic="going well" />
				</p>
			</Specimen>
		</Group>
	);
}

function Diagrams() {
	return (
		<Group id="diagrams" title="Diagrams">
			<Specimen
				id="system-diagram"
				title="SystemDiagram"
				tier="visual"
				components={["SystemDiagram"]}
				sentence="The inline SVG diagram of Tally's parts on How Tally works; scales to the screen width, with a title and description for screen readers."
			>
				<SystemDiagram />
			</Specimen>
			<Specimen
				id="how-diagrams"
				title="How Tally works' section diagrams"
				tier="visual"
				components={[
					"BudgetDiagram",
					"BillsDiagram",
					"TransactionsDiagram",
					"ExclusionsDiagram",
					"CategoriesDiagram",
				]}
				sentence="Drawn from the same numbers as each worked example. A dashed outline means “not counted” or “not decided yet.” These use sample numbers."
			>
				<State label="BudgetDiagram">
					<BudgetDiagram {...BUDGET_EXAMPLE} />
				</State>
				<State label="BillsDiagram">
					<BillsDiagram
						amount="$142.00"
						due="Sep 21"
						paid="Sep 24"
						windowDays={5}
						tolerance="10%"
					/>
				</State>
				<State label="TransactionsDiagram">
					<TransactionsDiagram {...TRANSACTIONS_EXAMPLE} />
				</State>
				<State label="ExclusionsDiagram">
					<ExclusionsDiagram {...EXCLUSIONS_EXAMPLE} />
				</State>
				<State label="CategoriesDiagram">
					<CategoriesDiagram {...CATEGORIES_EXAMPLE} />
				</State>
			</Specimen>
		</Group>
	);
}

/** What the chart space says, in words: a line's text alternative, or the early note and its sentence. */
const chartWords = (view: NetWorthView) =>
	view.kind === "line"
		? view.description
		: [view.sentence, view.note].filter(Boolean).join(" ");

/** What a picture of Accounts shows, in words, from the same data it draws. */
function describeAccounts() {
	return [
		"Accounts",
		`Net worth ${whole(NET_WORTH_CENTS)}`,
		chartWords(NET_WORTH_VIEWS.rising),
		"Sync now",
		...BANKS.map(
			(b) =>
				`${b.name}, Synced 12 minutes ago: ${b.accounts
					.map(
						(a) =>
							`${a.name} ending in ${a.mask} ${formatCents(a.isLiability ? -a.balanceCents : a.balanceCents)}`,
					)
					.join(
						", ",
					)}${b.needsAttention ? ". Needs attention: sign in again. Fix connection" : ""}`,
		),
		"Link a bank",
	].join(". ");
}

/**
 * The Accounts screen as the app will draw it (round 5 study, spec §8).
 * Sync now carries the app's id in one picture only, so the page has no duplicate id.
 */
function AccountsSketch({ syncId }: { syncId?: string }) {
	return (
		<>
			<AccountsTop
				netWorthCents={NET_WORTH_CENTS}
				history={NET_WORTH_VIEWS.rising}
				action={
					<div class="mt-4">
						<Button
							id={syncId}
							kind="secondary"
							type="button"
							busyLabel="Syncing…"
						>
							Sync now
						</Button>
					</div>
				}
			/>
			{BANKS.map((b) => (
				<BankGroup
					name={b.name}
					accounts={b.accounts}
					needsAttention={b.needsAttention}
					lastSyncedAt="2026-09-28 11:48:00"
					now={new Date("2026-09-28T12:00:00Z")}
					manageHref="/accounts/1/disconnect"
				/>
			))}
			<Button type="button" class="mt-8">
				Link a bank
			</Button>
		</>
	);
}

function AccountsGroup() {
	return (
		<Group id="accounts" title="Accounts">
			<Specimen
				id="accounts-screen"
				title="AccountsTop, SyncNow, BankGroup and AccountRow"
				tier="visual"
				components={["AccountsTop", "SyncNow", "BankGroup", "AccountRow"]}
				sentence="The Accounts screen from the round 5 study: Net worth as the serif headline over the net-worth chart (P25 A, below), then accounts grouped by bank, each with a muted Synced … line, and debt shown negative. A bank whose login needs fixing says so in words with an alert icon and offers Fix connection; Manage is a no-JavaScript disclosure containing the secondary Disconnect this bank action; a disconnected bank keeps its accounts and says Disconnected in muted words, with no Synced line, Manage or Fix connection. Link a bank is the primary button. Sync now, a secondary button under the title, syncs every healthy bank at most once a minute; while pending it says Syncing…, success shows a toast of what arrived (N new transactions, Nothing new, or Already synced a moment ago) and refreshes the banks, and failure puts one alert naming the bank above the summary. Fix connection requests a fresh update-mode Plaid Link session when clicked; while pending it is disabled and says Fixing…, success shows a Fixed bank toast and refreshes the banks, and failure puts an alert beside that bank's button. Link a bank requests a secure Plaid Link session and opens it; while a request is pending the button is disabled and says Linking…, success shows a Linked bank toast and refreshes the banks, and failure puts an alert beside the button."
			>
				<State label="A phone's first screen (390×844, less the tab bar)">
					<PhoneFrame
						label={`Accounts on a phone, top to bottom: ${describeAccounts()}`}
					>
						<AccountsSketch syncId="sync-now" />
					</PhoneFrame>
				</State>
				<State label="Desktop">
					<Picture
						label={`Accounts on desktop, top to bottom: ${describeAccounts()}`}
					>
						<AccountsSketch />
					</Picture>
				</State>
				<State label="A disconnected bank, its history kept">
					<div class="max-w-xl">
						<BankGroup
							name="Old Harbor Bank"
							accounts={[CHECKING]}
							disconnected
							manageHref="/accounts/1/disconnect"
						/>
					</div>
				</State>
				<State label="AccountRow on its own: a bank account, and a credit card whose debt shows negative">
					<ul class="max-w-xl divide-y divide-rule">
						<AccountRow {...CHECKING} />
						<AccountRow {...CREDIT_CARD} />
					</ul>
				</State>
			</Specimen>
			<Specimen
				id="net-worth-chart"
				title="NetWorthChart"
				tier="visual"
				components={["NetWorthChart"]}
				sentence="The line under Accounts' headline (P25 A, P26 A, P31). Code writes the change in a sentence in the status sentence's voice (Up $3,600 since May., Down $1,200 since May., or No change since May.; a history that began this month names the day, Up $120 since Oct 1.) followed by a terracotta Why? that goes to the Net worth section of How Tally works, then one server-drawn line through the last 6 months of net worth on the ledger rules, with its first and last day under it in muted words (May, Today). It has no amounts, axis or hover: the headline and the sentence carry the numbers, and the picture is an SVG with a text alternative that says the same in dollars. Net worth is every account's balance with debt subtracted, leaving out the Cash account and disconnected banks, read from one balance a day recorded when a sync refreshes balances; it starts on the first day every counted account has one, so linking another bank never looks like growth, and while a connected account has none at all there is no line (a line that left it out would disagree with the headline), only a note saying the chart waits for every account. Under two days of balances it is the five empty rules with a sentence and a note on when the chart starts (as P31 drew it). There is nothing to tap: a sync redraws it with the rest of Accounts, and the sync's toast is what is announced. Account rows keep today's balance only."
			>
				<State label="Six months, up (P25 A), at a phone's width">
					<div class="w-[358px] max-w-full">
						<Picture
							label={`Net worth chart on a phone: ${chartWords(NET_WORTH_VIEWS.rising)}`}
						>
							<NetWorthChart view={NET_WORTH_VIEWS.rising} />
						</Picture>
					</div>
				</State>
				<State label="The same on desktop: the line stretches to the page's width, and its strokes and dot stay the same size">
					<Picture
						label={`Net worth chart on desktop: ${chartWords(NET_WORTH_VIEWS.rising)}`}
					>
						<NetWorthChart view={NET_WORTH_VIEWS.rising} />
					</Picture>
				</State>
				<State label="Six months, down">
					<Picture
						label={`Net worth chart: ${chartWords(NET_WORTH_VIEWS.falling)}`}
					>
						<NetWorthChart view={NET_WORTH_VIEWS.falling} />
					</Picture>
				</State>
				<State label="A history that began this month: the line starts on a day">
					<Picture
						label={`Net worth chart: ${chartWords(NET_WORTH_VIEWS.startedThisMonth)}`}
					>
						<NetWorthChart view={NET_WORTH_VIEWS.startedThisMonth} />
					</Picture>
				</State>
				<State label="The first day (P31): when the chart starts">
					<Picture
						label={`Net worth chart: ${chartWords(NET_WORTH_VIEWS.firstDay)}`}
					>
						<NetWorthChart view={NET_WORTH_VIEWS.firstDay} />
					</Picture>
				</State>
				<State label="While a connected account has no balance recorded yet: no line, so it never disagrees with the headline">
					<Picture
						label={`Net worth chart: ${chartWords(NET_WORTH_VIEWS.waiting)}`}
					>
						<NetWorthChart view={NET_WORTH_VIEWS.waiting} />
					</Picture>
				</State>
				<State label="Before any balance is recorded">
					<Picture
						label={`Net worth chart: ${chartWords(NET_WORTH_VIEWS.none)}`}
					>
						<NetWorthChart view={NET_WORTH_VIEWS.none} />
					</Picture>
				</State>
			</Specimen>
		</Group>
	);
}

// ---------------------------------------------------------------------------------------------
// Trends (spec §8.3; P23 D, P24 A, P31, P33 A): every part drawn from the same page the app builds.

/** The catalog's full Trends sample, narrowed: a sample that isn't a full page is a mistake here. */
function fullTrends(): Extract<TrendsPage, { kind: "full" }> {
	const page = buildTrends(TRENDS_INPUT);
	if (page.kind !== "full")
		throw new Error("The catalog's Trends sample must be a full page");
	return page;
}
const TRENDS_FULL = fullTrends();
const GOING_WELL_ROW = TRENDS_FULL.goingWell[0] as TrendRowData;
const WORTH_A_LOOK_ROW = TRENDS_FULL.worthALook[0] as TrendRowData;
const OTHER_ROW = TRENDS_FULL.others[0] as TrendRowData;

const monthPoints = (cents: number[]): MonthPoint[] =>
	cents.map((c, i) => ({
		month: `2026-${String(10 - cents.length + 1 + i).padStart(2, "0")}`,
		cents: c,
		partial: i === cents.length - 1,
	}));
const rowOf = (
	name: string,
	cents: number[],
	line: string,
	icon = "groceries",
	color = "cat-blue",
	note: string | null = null,
): TrendRowData => {
	const months = monthPoints(cents);
	return {
		id: 0,
		name,
		icon,
		color,
		line,
		run: 0,
		note,
		months,
		label: monthsLabel(months, "Spending"),
	};
};
/** A row whose first month is a part month: history started on `from`, after the month's 1st. */
const withPart = (row: TrendRowData, from: string): TrendRowData => {
	const months = row.months.map((m, i) =>
		i === 0 ? { ...m, part: { from } } : m,
	);
	return { ...row, months, label: monthsLabel(months, "Spending") };
};
const TREND_ROW_STATES = [
	{
		label: "Going well: under budget three or more months running",
		row: GOING_WELL_ROW,
	},
	{
		label: "Worth a look: up three or more months running",
		row: WORTH_A_LOOK_ROW,
	},
	{
		label:
			"Worth a look and also under budget three or more months running: a muted second line says it still is",
		row: rowOf(
			"Groceries",
			[64000, 65500, 67000, 68500, 69000, 20000],
			"Up 3 months running",
			"groceries",
			"cat-blue",
			"Still under budget",
		),
	},
	{ label: "Every other category: last month's amount", row: OTHER_ROW },
	{
		label: "A short history: three months in, the bars sit at the right",
		row: rowOf("Groceries", [81000, 86000, 19600], "$860 in September"),
	},
	{
		label:
			"History started mid-July: July is a part month, so its small bar is striped and the text says from when",
		row: withPart(
			rowOf("Groceries", [43000, 79000, 86000, 19600], "$860 in September"),
			"2026-07-12",
		),
	},
	{
		label:
			"Refunds outweighed spending one month: a thin line, the amount in words",
		row: rowOf(
			"Kids",
			[24000, 26000, -2000, 6000],
			"-$20 in August",
			"kids",
			"cat-ochre",
		),
	},
	{
		label: "A long name truncates; the line stays whole",
		row: rowOf(
			"Dog walking, boarding and vet visits for Biscuit",
			[9000, 12000, 15000, 3000],
			"$150 in September",
			"list",
			"cat-slate",
		),
	},
];

/** What a picture of Trends shows, in words, built from the page it draws. */
function describeTrends(page: TrendsPage): string {
	if (page.kind === "empty")
		return "Trends with nothing to show yet: No spending to show yet. Trends fill in as your transactions arrive. Open Accounts";
	if (page.kind === "early")
		return `Trends with nothing to compare yet: Spent so far in ${page.monthName} ${trendsAmount(page.soFarCents)}. All spending. ${page.label} Trends fill in as months pass. Tally started in ${page.startMonthName}.`;
	const rows = (list: { name: string; line: string }[]) =>
		list.map((r) => `${r.name} ${r.line}`).join(", ");
	const parts = [
		`Spent so far in ${page.monthName} ${trendsAmount(page.soFarCents)}`,
		page.sentence,
		`${page.caption}: ${page.changes.map((c) => `${c.name} ${c.words}`).join(", ")}`,
		...(page.goingWell.length > 0
			? [`Going well: ${rows(page.goingWell)}`]
			: []),
		...(page.worthALook.length > 0
			? [`Worth a look: ${rows(page.worthALook)}`]
			: []),
		...(page.others.length > 0
			? [`Every other category, ${page.rangeLabel}: ${rows(page.others)}`]
			: []),
	];
	return parts.join(". ").replaceAll("..", ".");
}

/** An early-state page, for its bars; the catalog's samples are known to be early. */
function earlyPage(input: typeof TRENDS_EARLY_INPUT) {
	const page = buildTrends(input);
	if (page.kind !== "early")
		throw new Error("The catalog's early Trends sample must be an early page");
	return page;
}

// What's spent so far, and the sentence the same function the page uses writes for it.
const TRENDS_TOP_STATES = [
	["Less than by this time last month", 124000, 133000],
	["More", 168800, 155600],
	["Within a dollar, in words: never “$0 less”", 0, 0],
] as const;

function TrendsGroup() {
	const partPage = buildTrends(TRENDS_PART_INPUT);
	const early = earlyPage(TRENDS_EARLY_INPUT);
	const firstMonth = earlyPage(TRENDS_FIRST_MONTH_INPUT);
	const empty = buildTrends(TRENDS_EMPTY_INPUT);
	return (
		<Group id="trends" title="Trends">
			<Specimen
				id="trends-top"
				title="TrendsTop"
				tier="visual"
				components={["TrendsTop"]}
				sentence="The one thing on Trends (P23 D, P24 A): what's spent so far this month as the serif number, then a sentence written by code comparing it with the same days last month, with a Why? to the rule behind it."
			>
				{TRENDS_TOP_STATES.map(([label, now, then]) => {
					const sentence = compareSentence(now, then, "2026-09");
					return (
						<State label={label}>
							<Picture
								label={`Spent so far in October ${trendsAmount(now)}. ${sentence}`}
							>
								<TrendsTop
									month="October"
									spent={trendsAmount(now)}
									sentence={sentence}
								/>
							</Picture>
						</State>
					);
				})}
			</Specimen>
			<Specimen
				id="trend-group"
				title="TrendGroup"
				tier="visual"
				components={["TrendGroup"]}
				sentence="A small muted heading over a ruled list: Going well takes a check in ok, Worth a look an up arrow in ink, each with a Why? (a word and an icon, never color alone); the changes and every other category have a plain heading."
			>
				<State label="Going well, with its Why?">
					<div class="max-w-xl">
						<Picture label="Going well, with a Why? link, over one category row.">
							<TrendGroup
								id="ds-going-well"
								title="Going well"
								icon="check"
								tone="text-ok"
								why="going well"
							>
								<TrendRow {...GOING_WELL_ROW} id="ds-group-good" />
							</TrendGroup>
						</Picture>
					</div>
				</State>
				<State label="Worth a look, with its Why?">
					<div class="max-w-xl">
						<Picture label="Worth a look, with a Why? link, over one category row.">
							<TrendGroup
								id="ds-worth-a-look"
								title="Worth a look"
								icon="arrow-up"
								tone="text-ink"
								why="worth a look"
							>
								<TrendRow {...WORTH_A_LOOK_ROW} id="ds-group-watch" />
							</TrendGroup>
						</Picture>
					</div>
				</State>
				<State label="A plain heading: the range the changes cover">
					<div class="max-w-xl">
						<Picture label="Oct 1–5 against Sep 1–5, over one category's change.">
							<TrendGroup id="ds-changes" title={TRENDS_FULL.caption}>
								<ChangeRow {...(TRENDS_FULL.changes[0] as ChangeData)} />
							</TrendGroup>
						</Picture>
					</div>
				</State>
			</Specimen>
			<Specimen
				id="trend-row"
				title="TrendRow"
				tier="visual"
				components={["TrendRow"]}
				sentence="One category on Trends: its icon, name, a line of words (“4 months under budget”, “Up 3 months running”, “$150 in September”) and six small ink bars, scaled to the row's tallest month; the last, the month still going, is a dashed outline. The first month of history, when it may be only part of a month, is striped like MonthBars'. The bars carry their amounts in words for a screen reader, with from when for a part month."
			>
				{TREND_ROW_STATES.map((s, i) => (
					<State label={s.label}>
						<Picture label={`${s.row.name}, ${s.row.line}. ${s.row.label}`}>
							<ul>
								<TrendRow {...s.row} id={`ds-row-${i}`} />
							</ul>
						</Picture>
					</State>
				))}
			</Specimen>
			<Specimen
				id="change-row"
				title="ChangeRow"
				tier="visual"
				components={["ChangeRow"]}
				sentence="One category's change since the same days last month, in words with an arrow (“Up $31”). Spending more isn't a status, so it stays ink: green and brick mean on track and over budget. Equal amounts say “No change” with no arrow."
			>
				{TRENDS_FULL.changes.slice(0, 2).map((change) => (
					<State label={change.direction === "up" ? "Up" : "Down"}>
						<Picture
							label={`${change.name}, ${change.detail}. ${change.words}`}
						>
							<ul>
								<ChangeRow {...change} />
							</ul>
						</Picture>
					</State>
				))}
				<State label="Money counted but in no category, in Home's words, with its own muted icon">
					<Picture label="Needs a category, $23, was $0. Up $23">
						<ul>
							<ChangeRow
								name="Needs a category"
								icon="list"
								color=""
								detail="$23, was $0"
								direction="up"
								words="Up $23"
							/>
						</ul>
					</Picture>
				</State>
				<State label="The same amount: no arrow">
					<Picture label="Gas, $48, was $48. No change">
						<ul>
							<ChangeRow
								name="Gas"
								icon="gas"
								color="cat-slate"
								detail="$48, was $48"
								direction="same"
								words="No change"
							/>
						</ul>
					</Picture>
				</State>
			</Specimen>
			<Specimen
				id="month-bars"
				title="MonthBars"
				tier="visual"
				components={["MonthBars"]}
				sentence="All spending by month as bars on ledger rules with each amount above it: Trends' early state, before there's a full month to compare (P31). The month still going is a dashed outline that says “so far”. The first month of history may be only part of a month, so its bar is striped and its text alternative says it's a part month and from when."
			>
				<State label="Tally started last month: its first month, September, is striped (a part month, from Sep 12)">
					<Picture label={early.label}>
						<MonthBars
							id="ds-bars-early"
							months={early.months}
							label={early.label}
						/>
					</Picture>
				</State>
				<State label="Tally's very first month: striped, and still going, so dashed">
					<Picture label={firstMonth.label}>
						<MonthBars
							id="ds-bars-first"
							months={firstMonth.months}
							label={firstMonth.label}
						/>
					</Picture>
				</State>
				<State label="Nothing spent yet this month: a sliver, never a missing bar">
					<Picture label="All spending by month: October so far $0.">
						<MonthBars
							id="ds-bars-sliver"
							months={monthPoints([0])}
							label="All spending by month: October so far $0."
						/>
					</Picture>
				</State>
			</Specimen>
			<Specimen
				id="trends-screen"
				title="Trends, as a page"
				tier="visual"
				sentence="The page built from those parts (P23 D, P24 A, P31, P33 A): the one number and its sentence first, each category's change biggest first, then Going well, Worth a look and every other category with six small bars. One column, as wide as the Budget list on desktop."
			>
				<State label="A phone's first screen (390×844, less the tab bar)">
					<PhoneFrame
						label={`Trends on a phone's first screen, top to bottom: ${describeTrends(TRENDS_FULL)}`}
					>
						<TrendsScreen page={TRENDS_FULL} />
					</PhoneFrame>
				</State>
				<State label="Desktop: one column, wider">
					<Picture label={`Trends on desktop: ${describeTrends(TRENDS_FULL)}`}>
						<TrendsScreen page={TRENDS_FULL} />
					</Picture>
				</State>
				<State label="History started May 12: May is a part month, so its small bars are striped, and it isn't judged">
					<Picture label={`Trends: ${describeTrends(partPage)}`}>
						<TrendsScreen id="ds-screen-part" page={partPage} />
					</Picture>
				</State>
				<State label="One month in: all spending by month, and when Tally started">
					<PhoneFrame label={`Trends: ${describeTrends(early)}`}>
						<TrendsScreen id="ds-screen-early" page={early} />
					</PhoneFrame>
				</State>
				<State label="Tally's very first month">
					<Picture label={`Trends: ${describeTrends(firstMonth)}`}>
						<TrendsScreen id="ds-screen-first" page={firstMonth} />
					</Picture>
				</State>
				<State label="No transactions yet">
					<Picture label={`Trends: ${describeTrends(empty)}`}>
						<TrendsScreen page={empty} />
					</Picture>
				</State>
			</Specimen>
		</Group>
	);
}

/** The whole catalog page body. */
export function Catalog() {
	return (
		<>
			<Intro />
			<Foundation />
			<Brand />
			<Shell />
			<HomeTopGroup />
			<AccountsGroup />
			<TrendsGroup />
			<Rows />
			<Controls />
			<Feedback />
			<Demo />
			<Diagrams />
		</>
	);
}

/** The bottom sheet over sample rows, as it sits over Home or Transactions. */
export function SheetSpecimen() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				BottomSheet
			</h1>
			<p class="mt-2 text-muted">
				Visual: the sheet over sample rows. Cancel or the backdrop go back to
				the catalog. Opening this page plays the sheet's motion: it rises on a
				phone and slides in from the right on desktop.
			</p>
			<ul class="mt-6 max-w-xl">
				{PROGRESS_ROWS.map((s) => (
					<ProgressRow {...s.props} />
				))}
			</ul>
			<div hx-ignore="">
				<BottomSheet
					labelledBy="ds-sheet-title"
					closeHref="/design-system#bottom-sheet"
				>
					<h2
						id="ds-sheet-title"
						class="font-serif text-4xl font-semibold tracking-tight"
					>
						Groceries
					</h2>
					<p class="mt-2 text-muted">
						On phones it rises from the bottom; on desktop it's a panel on the
						right. It isn't a modal: the page behind it stays in place.
					</p>
					<div class="mt-4 flex flex-col gap-3 border-t border-rule pt-3">
						<p class="text-base text-ink">Income</p>
						<div class="flex flex-wrap gap-2">
							<Chip type="checkbox" name="ds-income" value="1">
								Count as income
							</Chip>
						</div>
					</div>
					<div class="mt-3 flex flex-wrap gap-2 border-t border-rule pt-3">
						<Chip type="checkbox" name="ds-credit-reviewed" value="1" checked>
							Reviewed as a refund or other non-income credit
						</Chip>
					</div>
					<Button
						href="/design-system#bottom-sheet"
						kind="secondary"
						class="mt-6"
					>
						Cancel
					</Button>
				</BottomSheet>
			</div>
		</>
	);
}
