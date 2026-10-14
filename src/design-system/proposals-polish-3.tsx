// P120 and P121 (decision 47; #84 and #498, #84's T3): the owner's pick between the edit panel's
// layouts (P120) and how much of Transactions' first screen goes to filters (P121). Each picture is
// the real components in src/views/ (DetailRow, Switch, Chip, FilterSelect, TransactionRow, ViewLinks,
// HowLink, WhyLink) with the prototypes the picked drawings left (Search, Footer, Row, TallSheet).
// Today is Mon Oct 13. Local Bakery needs a category; Trader Joe's was picked by Tally. The owner's
// picks (decision 111) are marked Picked.

import type { Child } from "hono/jsx";
import { dayLabel } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Wordmark } from "../views/brand";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { DetailRow } from "../views/detail-row";
import { FilterSelect } from "../views/filter-select";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { SIDEBAR_ITEMS, TAB_ITEMS } from "../views/nav";
import { NewCategoryChip } from "../views/new-category-choice";
import { Switch } from "../views/switch";
import { TransactionRow } from "../views/transaction-row";
import { ViewLinks } from "../views/view-links";
import { WhyLink } from "../views/why-link";
import {
	Fixed,
	type Option,
	Options,
	PickedPill,
	Replaced,
} from "./proposal-parts";
import {
	categoryValue,
	Footer,
	Row,
	TallSheet,
	transactionsBehind,
} from "./proposals-forms";
import {
	type Cat,
	EATING_OUT,
	GAS,
	GROCERIES,
	HOUSEHOLD,
	KIDS,
	Search,
	TITLE,
	tx,
} from "./proposals-phase5-transactions";
import { PhoneFrame, Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style: Monday, Oct 13.

const NOW = "2026-10-13";
const ACCOUNT = "Credit card ••9012";
const RENT: Cat = { name: "Rent", icon: "rent", color: "cat-slate" };
const CHILDCARE: Cat = { name: "Childcare", icon: "kids", color: "cat-blue" };
/** The demo's categories in their order: seven, so the two-column grid is four rows with New category last. */
const CATS: Cat[] = [
	GROCERIES,
	EATING_OUT,
	GAS,
	KIDS,
	HOUSEHOLD,
	CHILDCARE,
	RENT,
];

/** Needs a category: the bank's text is the one line that says what it was. */
const BAKERY = tx(70, NOW, "Local Bakery", 1200, undefined, {
	rawName: "SQ *LOCAL BAKERY 4432",
});
/** Picked by Tally, 92% sure, as Groceries. */
const TRADER = tx(71, NOW, "Trader Joe's", 6410, GROCERIES, {
	rawName: "TRADER JOE'S #552",
});
const BLUE = tx(72, "2026-10-12", "Blue Bottle Coffee", 650, EATING_OUT);
const PICKED = "Picked by Tally · 92% sure";

/** The Transactions list's rows for P121, all today. */
const LIST_ROWS: ListRow[] = [
	tx(41, NOW, "Paycheck", -245000, undefined, { income: true }),
	tx(42, NOW, "Farmers market", 2000, GROCERIES),
	tx(43, NOW, "Doordash taco", 3107, undefined, {
		rawName: "DD *DOORDASH TACO",
	}),
	tx(44, NOW, "City Water", 1399, HOUSEHOLD, {
		paysBill: true,
		billName: "Water",
	}),
	BAKERY,
	tx(46, NOW, "Banfield Pet Hospital", 18900, undefined, {
		rawName: "BANFIELD #1182",
	}),
];

// ---------------------------------------------------------------------------------------------
// Pictures: a phone's first screen (PhoneFrame), a phone cut short or with its tab bar (Glass), and
// the desktop pictures (Desk, DeskPanel). Glass is PhoneFrame with the height and tab bar left open.

/** The phone's tab bar, at the foot of its picture, from nav.tsx's own tab list; Transactions is the current one. */
function TabBar() {
	return (
		<div class="absolute inset-x-0 bottom-0 grid h-14 grid-cols-5 border-t border-rule bg-paper">
			{TAB_ITEMS.map((item) => (
				<span
					class={`flex flex-col items-center justify-center gap-1 text-xs ${item.key === "transactions" ? "text-accent" : "text-muted"}`}
				>
					<Icon name={item.icon} />
					{item.label}
				</span>
			))}
		</div>
	);
}

/** A phone picture at the height `box` names, with the demo banner and the masthead, and the tab bar if `tabs`. */
function Glass({
	box,
	label,
	tabs = false,
	children,
}: {
	box: string;
	label: string;
	tabs?: boolean;
	children?: Child;
}) {
	// A picture of a screen, not a working one: one labelled image with nothing inside to Tab to.
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={label}
				class={`relative ${box} w-[392px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper`}
			>
				<div inert>
					<p class="bg-band py-2 text-center text-sm text-muted">
						Demo data. Nothing here is real.
					</p>
					<div class="px-5 pt-6">
						<div class="mb-4">
							<Wordmark />
						</div>
						{children}
					</div>
				</div>
				{tabs && <TabBar />}
			</div>
		</div>
	);
}

/** A 1280-wide desktop window cropped to the picture: the sidebar from nav.tsx's own list, and the main column beside it. */
function Desk({ children }: { children?: Child }) {
	return (
		<div class="-mx-[104px] flex h-[528px] w-[720px]">
			<div class="flex w-[160px] shrink-0 flex-col border-r border-rule px-3 pt-1">
				{SIDEBAR_ITEMS.map((item) => (
					<span
						class={`flex min-h-11 items-center gap-2 text-sm ${item.key === "transactions" ? "font-semibold text-ink" : "text-muted"}`}
					>
						<Icon name={item.icon} class="size-5" />
						{item.label}
					</span>
				))}
			</div>
			<div class="min-w-0 flex-1 px-5">{children}</div>
		</div>
	);
}

/** The edit panel open beside the list at 1280: the list's day on the left, the panel on the right. */
function DeskPanel({ children }: { children?: Child }) {
	return (
		<div class="-mx-[104px] flex h-[528px] w-[720px]">
			<div class="w-[260px] shrink-0 border-r border-rule px-4">
				<DayRows rows={[BAKERY, TRADER, BLUE]} />
			</div>
			<div class="min-w-0 flex-1 px-5">{children}</div>
		</div>
	);
}

/** The list's rows under their day headings, as Transactions draws them. */
function DayRows({ rows }: { rows: ListRow[] }) {
	const days = [...new Set(rows.map((row) => row.date))];
	return (
		<>
			{days.map((date) => (
				<>
					<h2 class="mt-3 text-sm text-muted">{dayLabel(date, NOW)}</h2>
					<ul class="divide-y divide-rule">
						{rows
							.filter((row) => row.date === date)
							.map((row) => (
								<TransactionRow row={row} />
							))}
					</ul>
				</>
			))}
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P120: the edit panel. Its parts are shared by every option, drawn the same way.

/** A and B's head: the name as the one headline, its amount and day and account, then the bank's text. */
function Head({ row }: { row: ListRow }) {
	return (
		<div class="flex flex-col gap-1">
			<h2 class="font-serif text-3xl font-semibold tracking-tight">
				{row.displayName}
			</h2>
			<p class="text-muted">
				<span class="text-lg font-semibold text-ink">
					{formatCents(row.amountCents)}
				</span>{" "}
				· Today · {ACCOUNT}
			</p>
			<p class="text-sm text-muted">{row.rawName}</p>
		</div>
	);
}

/** The categories in two equal columns, the chosen one checked, New category last (decision 101). */
function Categories({ id, chosen }: { id: string; chosen?: Cat }) {
	return (
		<div class="grid grid-cols-2 gap-2">
			{CATS.map((c) => (
				<Chip
					type="radio"
					name={`${id}-cat`}
					value={c.name}
					checked={c.name === chosen?.name}
					icon={<CategoryIcon icon={c.icon} color={c.color} />}
				>
					{c.name}
				</Chip>
			))}
			<NewCategoryChip name={`${id}-cat`} />
		</div>
	);
}

/** The category, open: its legend, a line under it when Tally picked one, then the choices. */
function CategoryOpen({
	id,
	chosen,
	source,
}: {
	id: string;
	chosen?: Cat;
	source?: string;
}) {
	return (
		<fieldset class="flex flex-col gap-2">
			<legend class="text-base text-ink">Category</legend>
			{source && <p class="text-sm text-muted">{source}</p>}
			<Categories id={id} chosen={chosen} />
		</fieldset>
	);
}

/** #353's plain row (decision 101): unticked, the category is for this transaction only. */
function RuleRow({ id, name }: { id: string; name: string }) {
	return (
		<label class="flex min-h-11 items-start gap-3 py-2">
			<input
				type="checkbox"
				name={`${id}-always`}
				value="1"
				class="mt-1 size-5 shrink-0 accent-ink"
			/>
			<span class="flex min-w-0 flex-col">
				<span class="text-base text-ink">
					Use this category for {name} from now on
				</span>
				<span class="text-sm text-muted">
					Leave it unticked to change just this one.
				</span>
			</span>
		</label>
	);
}

function Exclude({ id }: { id: string }) {
	return (
		<Switch
			id={`${id}-excluded`}
			name="excluded"
			label="Exclude from budget"
			hint="It won't count in Spent or any budget."
		/>
	);
}

function Income({ id }: { id: string }) {
	return <Switch id={`${id}-income`} name="income" label="Count as income" />;
}

/** The four details as the real rows, each closed: a name Tally doesn't guess is "Your choice". */
function Details({ id, row }: { id: string; row: ListRow }) {
	return (
		<div class="border-t border-rule">
			<DetailRow
				id={`${id}-name`}
				label="Name"
				value={row.displayName}
				source="person"
			/>
			<DetailRow
				id={`${id}-what`}
				label="What it was"
				value={null}
				source="person"
			/>
			<DetailRow id={`${id}-kind`} label="Kind" value={null} source="person" />
			<DetailRow
				id={`${id}-for`}
				label="For"
				value="Add the people in your household"
				source="person"
			/>
		</div>
	);
}

function LooksRight() {
	return (
		<div class="flex flex-col items-start">
			<Button kind="secondary" type="button">
				Looks right
			</Button>
			<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
				Tally uses these when it picks a category.
				<WhyLink section="categorization" topic="Tally's guess" />
			</p>
		</div>
	);
}

/** Split, as a ruled link row with a muted chevron. */
function SplitRow() {
	return (
		<div class="flex min-h-12 items-center justify-between border-b border-rule">
			<span>Split</span>
			<span class="text-muted">
				<Icon name="chevron-right" class="size-5" />
			</span>
		</div>
	);
}

/** The explanation, moved to the end as a muted note (E5 took out How this works from the panel). */
const NOTE = (
	<p class="text-sm text-muted">
		From Northline Card Services. Its date and amount stay as the bank sent
		them. If something's off, you can split it, exclude it, or count it in
		another month.
	</p>
);

/** Today's panel as it is: the bank's text, the name and the amount in serif, the day, the explanation, How this works, Split, the details. */
function TodayPanel({ id, row }: { id: string; row: ListRow }) {
	return (
		<>
			<p class="text-sm text-muted">{row.rawName}</p>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				{row.displayName}
			</h2>
			<p class="font-serif text-4xl font-semibold">
				{formatCents(row.amountCents, { signed: true })}
			</p>
			<p class="text-muted">
				{dayLabel(row.date, NOW)} · {ACCOUNT}
			</p>
			<p class="mt-2 text-sm text-muted">
				From Northline Card Services. Its date and amount stay as the bank sent
				them. If something's off, you can split it, exclude it, or count it in
				another month.
			</p>
			<p>
				<HowLink section="categorization" />
			</p>
			<Button kind="secondary" type="button" class="w-full">
				Split
			</Button>
			<Details id={id} row={row} />
		</>
	);
}

/** A: the category first, always open; then the rule row, Exclude, the details, Looks right, Split, Income, the note. */
function OpenPanel({
	id,
	row,
	chosen,
	source,
}: {
	id: string;
	row: ListRow;
	chosen?: Cat;
	source?: string;
}) {
	return (
		<>
			<Head row={row} />
			<CategoryOpen id={id} chosen={chosen} source={source} />
			<RuleRow id={id} name={row.displayName} />
			<Exclude id={id} />
			<Details id={id} row={row} />
			<LooksRight />
			<SplitRow />
			<Income id={id} />
			{NOTE}
		</>
	);
}

/** B for a sorted transaction: its category is one row, which opens to the choices. */
function FoldedPanel({
	id,
	row,
	open = false,
}: {
	id: string;
	row: ListRow;
	open?: boolean;
}) {
	return (
		<>
			<Head row={row} />
			<Row
				label="Category"
				sub={PICKED}
				value={categoryValue(GROCERIES)}
				open={open}
			>
				<div class="flex flex-col gap-3 pb-3 pt-1">
					<Categories id={id} chosen={GROCERIES} />
					<RuleRow id={id} name={row.displayName} />
				</div>
			</Row>
			<Exclude id={id} />
			<Details id={id} row={row} />
			<LooksRight />
			<SplitRow />
			<Income id={id} />
			{NOTE}
		</>
	);
}

/** One ruled row of C's table: its label in muted words, its value on a hairline with its source under it. */
function LedgerRow({
	label,
	value,
	sub,
	open = false,
	children,
}: {
	label: string;
	value: Child;
	sub?: Child;
	open?: boolean;
	children?: Child;
}) {
	return (
		<details class="group border-b border-rule" open={open}>
			<summary class="grid min-h-12 cursor-pointer list-none grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-3 py-2 [&::-webkit-details-marker]:hidden">
				<span class="self-start pt-1 text-sm text-muted">{label}</span>
				<span class="min-w-0 border-l border-rule pl-3">
					<span class="flex min-w-0 items-center gap-2 text-lg">{value}</span>
					{sub && <span class="block text-sm text-muted">{sub}</span>}
				</span>
				<span class="shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
					<Icon name="chevron-right" class="size-5" />
				</span>
			</summary>
			{children}
		</details>
	);
}

/** C: the amount is the headline, the bank's text above it and the day under it; then one ruled table. */
function LedgerPanel({
	id,
	row,
	chosen,
	source,
	open = false,
}: {
	id: string;
	row: ListRow;
	chosen?: Cat;
	source?: string;
	open?: boolean;
}) {
	return (
		<>
			<p class="text-sm text-muted">{row.rawName}</p>
			<h2 class="font-serif text-4xl font-semibold tabular-nums">
				<span class="sr-only">{row.displayName}, </span>
				{formatCents(row.amountCents)}
			</h2>
			<p class="text-muted">
				{dayLabel(row.date, NOW)} · {ACCOUNT}
			</p>
			<div class="flex flex-col">
				<LedgerRow
					label="Category"
					value={chosen ? categoryValue(chosen) : "Add"}
					sub={source}
					open={open}
				>
					<div class="pb-3 pt-1">
						<Categories id={id} chosen={chosen} />
					</div>
				</LedgerRow>
				<label class="grid min-h-12 grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-3 border-b border-rule py-2">
					<span class="flex justify-end pt-1">
						<input
							type="checkbox"
							name={`${id}-always`}
							value="1"
							class="size-5 accent-ink"
						/>
					</span>
					<span class="min-w-0 border-l border-rule pl-3">
						<span class="block text-base text-ink">
							Use this category for {row.displayName} from now on
						</span>
						<span class="block text-sm text-muted">
							Leave it unticked to change just this one.
						</span>
					</span>
					<span />
				</label>
				<LedgerRow label="Name" value={row.displayName} sub="Your choice" />
				<LedgerRow label="What it was" value="Add" sub="Your choice" />
				<LedgerRow label="Kind" value="Add" sub="Your choice" />
				<LedgerRow
					label="For"
					value="Add the people in your household"
					sub="Your choice"
				/>
				<div class="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-start gap-3 border-b border-rule py-3">
					<span />
					<span class="min-w-0 border-l border-rule pl-3">
						<LooksRight />
					</span>
					<span />
				</div>
				<SplitRow />
			</div>
			<Exclude id={id} />
			<Income id={id} />
			{NOTE}
		</>
	);
}

/**
 * A panel's parts in one column that doesn't shrink: a rule or switch row has a minimum height, which
 * turns off a flex item's automatic minimum, so a sheet's own flex column squeezes its rows into their
 * minimum and their words spill over the next row. Inside this column the parts keep their height, and
 * the sheet's scrolling part still cuts the column where the picture ends.
 */
function PanelBody({ children }: { children?: Child }) {
	return <div class="flex shrink-0 flex-col gap-5">{children}</div>;
}

/** A panel's sheet over the dimmed list, cut where the picture ends, with the pinned Cancel and Save when `save`. */
function sheetPicture(label: string, panel: Child, save = false) {
	return (
		<PhoneFrame label={label}>
			<TallSheet
				behind={transactionsBehind}
				footer={save ? <Footer save="Save" /> : undefined}
			>
				<PanelBody>{panel}</PanelBody>
			</TallSheet>
		</PhoneFrame>
	);
}

// ---------------------------------------------------------------------------------------------
// P121: the Transactions header and its filters. Each part is the page's own, as today's page draws it.

/** Transactions' title, Select, and the With Tally · Without Tally links under it. */
function ListTop({ p }: { p: string }) {
	return (
		<>
			<div class="flex items-center justify-between gap-3">
				<h1 class={TITLE}>Transactions</h1>
				<Button kind="text" type="button" class="-mr-2">
					Select
				</Button>
			</div>
			<div class="mt-2">
				<ViewLinks id={`${p}-views`} current="made" madeHref="#" bankHref="#" />
			</div>
		</>
	);
}

const addCash = (
	<Button kind="secondary" type="button" class="gap-2">
		<Icon name="plus" class="size-5" /> Add cash
	</Button>
);

/** The four filters, each a FilterSelect showing its choice: October, All categories, All accounts, All. */
function filterList(p: string): Child[] {
	return [
		<FilterSelect
			id={`${p}-month`}
			name="month"
			label="Month"
			options={[
				{ value: "2026-10", label: "October" },
				{ value: "all", label: "All months" },
			]}
			selected="2026-10"
		/>,
		<FilterSelect
			id={`${p}-category`}
			name="category"
			label="Category"
			options={[
				{ value: "", label: "All categories" },
				...CATS.map((c) => ({ value: c.name, label: c.name })),
			]}
			selected={null}
		/>,
		<FilterSelect
			id={`${p}-account`}
			name="account"
			label="Account"
			options={[
				{ value: "", label: "All accounts" },
				{ value: "9012", label: ACCOUNT },
			]}
			selected={null}
		/>,
		<FilterSelect
			id={`${p}-show`}
			name="show"
			label="Show"
			options={[
				{ value: "all", label: "All" },
				{ value: "income", label: "Income" },
			]}
			selected={null}
		/>,
	];
}

/** The Needs category shortcut: a chip that counts what still needs one. */
function needsChip(p: string) {
	return (
		<Chip type="checkbox" name={`${p}-needs`} value="1">
			<span>
				Needs category (<span>10</span>)
			</span>
		</Chip>
	);
}

const COUNT = (
	<p class="mt-4 text-sm text-muted">
		Showing 1–25 of 42 transactions in October
	</p>
);

const DASHED = (
	<p class="mb-2 flex flex-wrap items-center gap-x-1 text-sm text-muted">
		Dashed names are suggestions.
		<WhyLink section="names" topic="suggested name" />
	</p>
);

/** Today's header as it is: the four filters wrapping in a row, then the Needs category chip. */
function TodayPage({ p }: { p: string }) {
	return (
		<>
			<ListTop p={p} />
			<div class="mt-3">{addCash}</div>
			<HowLink section="transactions" />
			<div class="mt-3">
				<Search id={`${p}-q`} q="" />
			</div>
			<div class="mt-3 flex flex-wrap gap-2">{filterList(p)}</div>
			<div class="mt-3 flex flex-wrap gap-2">{needsChip(p)}</div>
			{COUNT}
			{DASHED}
			<DayRows rows={LIST_ROWS} />
		</>
	);
}

/** A's one pill: a closed disclosure styled as a FilterSelect pill, which opens to the four filters. */
function FilterPill({ p, open = false }: { p: string; open?: boolean }) {
	return (
		<details class="group open:w-full" open={open}>
			<summary class="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-rule px-4 text-base text-ink [&::-webkit-details-marker]:hidden">
				<span class="shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
					<Icon name="chevron-right" class="size-4" />
				</span>
				Filters
			</summary>
			<div class="mt-3 flex flex-wrap gap-2">{filterList(p)}</div>
		</details>
	);
}

/** A: search and Needs category stay in view; the four filters fold behind one Filters pill. */
function FoldedPage({ p, open = false }: { p: string; open?: boolean }) {
	return (
		<>
			<ListTop p={p} />
			<div class="mt-2 flex flex-wrap items-center gap-x-4">
				{addCash}
				<HowLink section="transactions" />
			</div>
			<div class="mt-3">
				<Search id={`${p}-q`} q="" />
			</div>
			<div class="mt-3 flex flex-wrap items-center gap-2">
				<FilterPill p={p} open={open} />
				{needsChip(p)}
			</div>
			{COUNT}
			<DayRows rows={LIST_ROWS} />
			<div class="mt-3">{DASHED}</div>
		</>
	);
}

/**
 * B: the Needs category chip and the four filters in one row that scrolls sideways, with a paper fade at its
 * edge; `wrap` draws it in two lines instead (desktop). The phone's row is drawn 32px scrolled, so the Needs
 * chip starts a little past the left edge and All categories shows cut off under the fade, where a person can
 * tell there is more.
 */
function StripPage({ p, wrap = false }: { p: string; wrap?: boolean }) {
	return (
		<>
			<ListTop p={p} />
			<div class="mt-2 flex flex-wrap items-center gap-x-4">
				{addCash}
				<HowLink section="transactions" />
			</div>
			<div class="mt-3">
				<Search id={`${p}-q`} q="" />
			</div>
			{wrap ? (
				<div class="mt-3 flex flex-wrap gap-2">
					{needsChip(p)}
					{filterList(p)}
				</div>
			) : (
				<div class="relative -mx-5 mt-3">
					<div class="flex gap-2 overflow-x-auto px-5 py-1">
						<span class="shrink-0 -ml-8">{needsChip(p)}</span>
						{filterList(p).map((item) => (
							<span class="shrink-0">{item}</span>
						))}
					</div>
					<div
						aria-hidden="true"
						class="pointer-events-none absolute inset-y-0 right-0 w-16 bg-[linear-gradient(to_right,transparent,var(--color-paper)_85%)]"
					/>
				</div>
			)}
			{COUNT}
			<DayRows rows={LIST_ROWS} />
			<div class="mt-3">{DASHED}</div>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// The options and the sections.

/** An option drawn with one picture or with several side by side (`wide`), its head as Options draws it. */
type Wide = Option & { wide?: boolean };

/**
 * The options side by side, each named, described and weighed above its pictures. Several pictures
 * sit in one `data-screen` box, so a test still finds one drawn picture per option.
 */
function Pictured({ options }: { options: Wide[] }) {
	return (
		<div class="flex flex-wrap gap-8">
			{options.map((o) => (
				<div
					class={`flex ${o.wide ? "w-[800px]" : "w-[392px]"} max-w-full flex-col gap-2`}
				>
					<div class="flex flex-col gap-1">
						<h4 class="flex flex-wrap items-center gap-x-2 font-semibold">
							{o.name}
							{o.recommended && (
								<span class="rounded-full border border-ink px-2.5 py-0.5 text-sm font-medium">
									Recommended
								</span>
							)}
							{o.picked && <PickedPill />}
						</h4>
						<p class="text-sm">{o.note}</p>
						{o.tradeoff && (
							<p class="text-sm text-muted">Trade-off: {o.tradeoff}</p>
						)}
						{o.recommended && (
							<p class="text-sm text-muted">Why: {o.recommended}</p>
						)}
					</div>
					<div data-screen="picture">
						<div class="flex flex-wrap items-start gap-4">{o.screen}</div>
					</div>
				</div>
			))}
		</div>
	);
}

const panelOptions: Wide[] = [
	{
		name: "Today (current)",
		note: "The panel as it is: the bank's text, the name and the amount, the explanation and How this works, then Split and the details. The categories come after them.",
		wide: true,
		screen: (
			<>
				{sheetPicture(
					"Today (current), Local Bakery, on a phone",
					<TodayPanel id="p120-today-lb" row={BAKERY} />,
				)}
				{sheetPicture(
					"Today (current), Trader Joe's, on a phone",
					<TodayPanel id="p120-today-tj" row={TRADER} />,
				)}
			</>
		),
	},
	{
		name: "A · Category first",
		note: "The category comes right after the name, always open, and everything else follows in the order people use it.",
		tradeoff:
			"a long panel below the first screen; at 50 categories the grid is long.",
		wide: true,
		screen: (
			<>
				{sheetPicture(
					"A · Category first, Local Bakery, on a phone",
					<OpenPanel id="p120-a-lb" row={BAKERY} />,
					true,
				)}
				{sheetPicture(
					"A · Category first, Trader Joe's, on a phone",
					<OpenPanel
						id="p120-a-tj"
						row={TRADER}
						chosen={GROCERIES}
						source={PICKED}
					/>,
					true,
				)}
			</>
		),
	},
	{
		name: "B · Category leads, folds when set",
		picked: true,
		note: "When a transaction needs a category the choices lead; when it has one, it's one line you can open.",
		tradeoff: "changing an already-sorted category takes one extra tap.",
		recommended:
			"A sorted transaction opens as a short, calm sheet; an unsorted one opens straight to its choices.",
		wide: true,
		screen: (
			<>
				{sheetPicture(
					"B · Category leads, folds when set, Local Bakery, on a phone",
					<OpenPanel id="p120-b-lb" row={BAKERY} />,
					true,
				)}
				{sheetPicture(
					"B · Category leads, folds when set, Trader Joe's, on a phone",
					<FoldedPanel id="p120-b-tj" row={TRADER} />,
					true,
				)}
				<Glass
					box="h-[640px]"
					label="B · Category leads, folds when set, Trader Joe's with Category open, on a phone"
				>
					<TallSheet
						behind={transactionsBehind}
						footer={<Footer save="Save" />}
					>
						<PanelBody>
							<FoldedPanel id="p120-b-tj-open" row={TRADER} open />
						</PanelBody>
					</TallSheet>
				</Glass>
			</>
		),
	},
	{
		name: "C · Ruled ledger",
		note: "The whole transaction reads as one ruled ledger page, the amount at its head, and the line that needs you opens by itself.",
		tradeoff:
			"the detail rows change shape, and the name is no longer the big title.",
		wide: true,
		screen: (
			<>
				{sheetPicture(
					"C · Ruled ledger, Local Bakery, on a phone",
					<LedgerPanel id="p120-c-lb" row={BAKERY} open />,
					true,
				)}
				{sheetPicture(
					"C · Ruled ledger, Trader Joe's, on a phone",
					<LedgerPanel
						id="p120-c-tj"
						row={TRADER}
						chosen={GROCERIES}
						source={PICKED}
					/>,
					true,
				)}
			</>
		),
	},
];

const panelDesktop: Option[] = [
	{
		name: "At 1280: Today (current)",
		note: "The panel open beside the list on Local Bakery, as it is now.",
		desktop: true,
		screen: (
			<DeskPanel>
				<TodayPanel id="p120-desk-today" row={BAKERY} />
			</DeskPanel>
		),
	},
	{
		name: "At 1280: B · Category leads, folds when set",
		picked: true,
		note: "The same panel for Local Bakery, with its categories open.",
		desktop: true,
		screen: (
			<DeskPanel>
				<PanelBody>
					<OpenPanel id="p120-desk-b" row={BAKERY} />
				</PanelBody>
			</DeskPanel>
		),
	},
];

const filterOptions: Wide[] = [
	{
		name: "Today (current)",
		note: "Today's header: all four filters in a row, then the Needs category chip, then the list.",
		screen: (
			<Glass box="h-[844px]" label="Today (current), on a phone" tabs>
				<TodayPage p="p121-today" />
			</Glass>
		),
	},
	{
		name: "A · Filters fold away",
		picked: true,
		note: "Search and Needs category stay in view; the four filters fold behind one Filters pill.",
		tradeoff: "changing the month or account takes one more tap.",
		recommended:
			"About five transactions on the first screen instead of one and a half.",
		wide: true,
		screen: (
			<>
				<Glass box="h-[844px]" label="A · Filters fold away, on a phone" tabs>
					<FoldedPage p="p121-a" />
				</Glass>
				<Glass
					box="h-[640px]"
					label="A · Filters fold away, with the Filters pill open, on a phone"
				>
					<FoldedPage p="p121-a-open" open />
				</Glass>
			</>
		),
	},
	{
		name: "B · One filter strip",
		note: "Every filter stays visible in one sideways row.",
		tradeoff: "Account and Show are found by swiping.",
		screen: (
			<Glass box="h-[844px]" label="B · One filter strip, on a phone" tabs>
				<StripPage p="p121-b" />
			</Glass>
		),
	},
];

const filterDesktop: Option[] = [
	{
		name: "At 1280: Today (current)",
		note: "The same header on a wide screen, with the four filters in a row.",
		desktop: true,
		screen: (
			<Desk>
				<TodayPage p="p121-desk-today" />
			</Desk>
		),
	},
	{
		name: "At 1280: A · Filters fold away",
		picked: true,
		note: "The Filters pill on a wide screen, closed.",
		desktop: true,
		screen: (
			<Desk>
				<FoldedPage p="p121-desk-a" />
			</Desk>
		),
	},
	{
		name: "At 1280: B · One filter strip",
		note: "The filters on a wide screen wrap onto two lines, with no fade.",
		desktop: true,
		screen: (
			<Desk>
				<StripPage p="p121-desk-b" wrap />
			</Desk>
		),
	},
];

/** P120 and P121 on the proposals page, picked (decision 111): each option drawn, the owner's pick marked. */
export function PolishRoundBProposals() {
	return (
		<>
			<Specimen
				id="p120-panel"
				title="P120 · What the edit panel leads with"
				tier="visual"
				sentence="Which part of the edit panel comes first, and how its categories are laid out. Pick one. Each is drawn on a phone for Local Bakery, which needs a category, and for Trader Joe's, which Tally picked, with a desktop pair under them."
			>
				<Fixed>
					one Save does what's chosen and New category is one of the choices
					(decision 101); a rule is only made when the person ticks it (decision
					101, #353); Tally's guesses look like guesses (P87 B); the details
					Tally fills in are the owner's own idea (P89 A); sheets pin Cancel and
					Save (P72 A).
				</Fixed>
				<Pictured options={panelOptions} />
				<Options options={panelDesktop} />
			</Specimen>
			<Specimen
				id="p121-header"
				title="P121 · How much of Transactions' first screen goes to filters"
				tier="visual"
				sentence="How many filters stay in view at the top of Transactions. Pick one. Each is a phone's first screen at 390 wide, with the tab bar, and a desktop picture under it. A also shows its Filters pill open."
			>
				<Fixed>
					FilterSelect's pill look (P63 A, P64 B); the count says what's shown
					and is what a screen reader hears after a filter changes; With Tally ·
					Without Tally (decision 103); search; the Needs category shortcut.
				</Fixed>
				<Replaced decision={111}>
					Since P124 A (decision 111), How this works sits at the foot of the
					page, not beside Add cash; Add cash keeps its own line.
				</Replaced>
				<Pictured options={filterOptions} />
				<Options options={filterDesktop} />
			</Specimen>
		</>
	);
}
