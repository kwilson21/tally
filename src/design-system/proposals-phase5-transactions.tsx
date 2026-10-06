// P62–P71 (spec §8.4, decisions 66 and 67; docs/reviews/original-app-gaps.md C2–C8): rule
// suggestions, a filter by account, a type filter, a smarter search, a new category while
// categorizing, renaming one transaction, seeing and removing rules, select all, and editing a
// cash entry. Each option is drawn on a phone's first screen from the real components with
// demo-style data (today is Mon Oct 5), so the owner can pick by seeing (decision 47). Where a
// piece is new, a prototype is drawn here in tokens. Nothing here is decided until the owner picks.

import type { Child } from "hono/jsx";
import { dayLabel } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { AccountsTop } from "../views/accounts-top";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { FormField } from "../views/form-field";
import { Icon } from "../views/icons";
import { MoneyInput } from "../views/money-input";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { netWorthViewEnding } from "./mock";
import { Fixed, Options } from "./proposal-parts";
import { Specimen } from "./specimen";

/**
 * A rule the spec still needs before the feature is built, or, once the owner has answered it,
 * the rule as settled and the decision that settled it (`settled`), so a picked drawing never
 * shows an answered question as open.
 */
export function NeedsLine({
	children,
	settled,
}: {
	children?: Child;
	settled?: string;
}) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">
				{settled
					? `Rule settled (${settled}): `
					: "Rule to write before building: "}
			</span>
			{children}
		</p>
	);
}

export const TODAY = "2026-10-05";
export const CARD = "Chase Card ••9921";

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style: October, five days in.

export type Cat = { name: string; icon: string; color: string };
export const GROCERIES: Cat = {
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
};
export const EATING_OUT: Cat = {
	name: "Eating Out",
	icon: "eating-out",
	color: "cat-plum",
};
export const KIDS: Cat = { name: "Kids", icon: "kids", color: "cat-ochre" };
export const GAS: Cat = { name: "Gas", icon: "gas", color: "cat-slate" };
export const HOUSEHOLD: Cat = {
	name: "Household",
	icon: "household",
	color: "cat-brown",
};
export const FIVE = [GROCERIES, EATING_OUT, KIDS, GAS, HOUSEHOLD];
export const FOUR = [GROCERIES, EATING_OUT, KIDS, HOUSEHOLD];
export const THREE = [GROCERIES, EATING_OUT, HOUSEHOLD];

/** A list row as the app loads it; amounts are Plaid's way round (positive is money out). */
export function tx(
	id: number,
	date: string,
	name: string,
	amountCents: number,
	cat?: Cat,
	extra: Partial<ListRow> = {},
): ListRow {
	return {
		id,
		date,
		amountCents,
		rawName: name,
		displayName: name,
		note: null,
		excluded: false,
		income: false,
		creditReviewed: true,
		categoryId: cat ? 1 : null,
		categoryName: cat?.name ?? null,
		categoryIcon: cat?.icon ?? null,
		categoryColor: cat?.color ?? null,
		...extra,
	};
}

export const BLUE_BOTTLE = tx(
	1,
	"2026-10-05",
	"Blue Bottle Coffee",
	650,
	EATING_OUT,
);
export const TRADER_JOES = tx(2, "2026-10-04", "Trader Joe's", 8217, GROCERIES);
export const LUPITAS = tx(
	3,
	"2026-10-04",
	"Lupita's Taqueria",
	4290,
	EATING_OUT,
);
export const COSTCO = tx(4, "2026-10-03", "Costco", 14260, GROCERIES);
export const AMAZON = tx(5, "2026-10-02", "Amazon", 4217, HOUSEHOLD);
export const SHELL = tx(6, "2026-10-02", "Shell", 4410, GAS);
const PAYROLL = tx(7, "2026-10-01", "Acme Payroll", -245000, undefined, {
	income: true,
});
const INTEREST = tx(8, "2026-10-01", "Savings interest", -418, undefined, {
	income: true,
});
const FARMERS = tx(10, "2026-10-04", "Farmers market", 1850, GROCERIES);
const CHEWY = tx(11, "2026-10-04", "Chewy", 6412);

/** Costco on its other visits, for a search across months. */
const OLDER_COSTCO = [
	tx(21, "2026-09-28", "Costco", 15840, GROCERIES),
	tx(22, "2026-09-12", "Costco", 13205, GROCERIES),
	tx(23, "2026-08-30", "Costco", 16110, GROCERIES),
	tx(24, "2026-08-16", "Costco", 12470, GROCERIES),
];

/** Amazon rows whose caption reads "category · note": the proposal, drawn on the real row. */
const withNote = (id: number, date: string, cents: number, note?: string) =>
	tx(id, date, "Amazon", cents, undefined, {
		categoryId: 1,
		categoryName: note ? `Household · ${note}` : "Household",
		categoryIcon: "household",
		categoryColor: "cat-brown",
	});

// ---------------------------------------------------------------------------------------------
// The Transactions page, as the app draws it: title, Add cash, the filters, the count, the list.

type DaysProps = { rows: ListRow[]; select?: boolean; checked?: number[] };

/** Rows grouped under their day, as the list does; in Select mode each row has its round tick. */
export function Days({ rows, select, checked }: DaysProps) {
	const days: [string, ListRow[]][] = [];
	for (const row of rows) {
		const last = days.at(-1);
		if (last && last[0] === row.date) last[1].push(row);
		else days.push([row.date, [row]]);
	}
	return (
		<>
			{days.map(([date, dayRows]) => (
				<>
					<h2 class="mt-3 text-sm text-muted">{dayLabel(date, TODAY)}</h2>
					<ul class="divide-y divide-rule">
						{dayRows.map((row) =>
							select ? (
								<SelectableTransactionRow
									row={row}
									checked={checked?.includes(row.id)}
								/>
							) : (
								<TransactionRow row={row} />
							),
						)}
					</ul>
				</>
			))}
		</>
	);
}

export const TITLE = "font-serif text-5xl font-semibold tracking-tight";

export function TxHeader() {
	return (
		<>
			<div class="flex items-center justify-between gap-3">
				<h1 class={TITLE}>Transactions</h1>
				<Button kind="text" type="button" class="-mr-2">
					Select
				</Button>
			</div>
			<div class="mt-3">
				<Button kind="secondary" type="button" class="gap-2">
					<Icon name="plus" class="size-5" /> Add cash
				</Button>
			</div>
		</>
	);
}

type SearchProps = {
	id: string;
	q: string;
	hint?: string;
	/** What it searches, in the words of its label and placeholder. */
	what?: string;
};

/** The search box, as the page draws it; a hint, when given, sits under it. */
export function Search({ id, q, hint, what = "transactions" }: SearchProps) {
	return (
		<FormField id={id} label={`Search ${what}`} hideLabel hint={hint}>
			{(a11y) => (
				<div class="relative">
					<span class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
						<Icon name="search" class="size-5" />
					</span>
					<input
						id={id}
						name="q"
						type="search"
						value={q}
						placeholder={`Search ${what}`}
						autocomplete="off"
						class="min-h-11 w-full rounded-control border border-rule bg-band py-2 pl-10 pr-3 text-lg"
						{...a11y}
					/>
				</div>
			)}
		</FormField>
	);
}

type PillProps = { id: string; label: string; value: string };

/** A filter choice as the page draws it: a pill-shaped select, showing the chosen option. */
function Pill({ id, label, value }: PillProps) {
	return (
		<>
			<label for={id} class="sr-only">
				{label}
			</label>
			<select
				id={id}
				class="min-h-11 rounded-full border border-rule bg-paper px-4 text-base text-ink"
			>
				<option>{value}</option>
			</select>
		</>
	);
}

const TYPES = ["All", "Spending", "Income", "Refunds", "Excluded"];

type TxProps = {
	/** Makes this picture's control ids unique on the page. */
	p: string;
	/** The aria-live count above the list: it names every active filter. */
	count: string;
	rows: ListRow[];
	q?: string;
	hint?: string;
	/** A line under the search box (P66 B's month links). */
	underSearch?: Child;
	month?: string;
	/** P63: an Account choice among the filters. */
	account?: string;
	/** P64 B: a "Show" choice holding the types. */
	show?: string;
	/** P64 A: the types as chips, with this one chosen. */
	type?: string;
	/** A line under the count (P66 A's "Only October"). */
	afterCount?: Child;
};

/** Transactions with its filters and count, as the app draws them today plus what's proposed. */
function Transactions(props: TxProps) {
	const { p, month = "October", account, show, type } = props;
	return (
		<>
			<TxHeader />
			<div class="mt-4 flex flex-col gap-3">
				<Search id={`${p}-q`} q={props.q ?? ""} hint={props.hint} />
				{props.underSearch}
				<div class="flex flex-wrap gap-2">
					<Pill id={`${p}-month`} label="Month" value={month} />
					<Pill id={`${p}-category`} label="Category" value="All categories" />
					{account && (
						<Pill id={`${p}-account`} label="Account" value={account} />
					)}
					{show && <Pill id={`${p}-show`} label="Show" value={show} />}
				</div>
				{type && (
					<fieldset class="flex flex-wrap gap-2">
						<legend class="sr-only">Type</legend>
						{TYPES.map((t) => (
							<Chip
								type="radio"
								name={`${p}-type`}
								value={t}
								checked={t === type}
							>
								{t}
							</Chip>
						))}
					</fieldset>
				)}
				<div class="flex flex-wrap gap-2">
					<Chip type="checkbox" name={`${p}-needs`} value="1">
						<span>
							Needs category (<span>3</span>)
						</span>
					</Chip>
					{/* Today's Excluded chip; the type choices replace it. */}
					{!type && !show && (
						<Chip type="checkbox" name={`${p}-excluded`} value="1">
							Excluded
						</Chip>
					)}
				</div>
			</div>
			<p aria-live="polite" class="mt-4 text-sm text-muted">
				{props.count}
			</p>
			{props.afterCount}
			<div class="mt-2">
				<Days rows={props.rows} />
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// The edit panel. The real BottomSheet grows to 90% of the screen, so this one is drawn as tall as
// its content, with the list dimmed above it; the sheet scrolls, so a long panel is cropped here.

export function PanelSheet({
	behind,
	tall,
	children,
}: {
	/** The page above the panel, when it isn't the list's top. */
	behind?: Child;
	/** For a panel that doesn't fit in 686px: draw it on a tall phone (the option's `tall`), 766px. */
	tall?: boolean;
	children?: Child;
}) {
	return (
		<div
			class={`relative -mx-5 ${tall ? "h-[766px]" : "h-[686px]"} overflow-hidden`}
		>
			<div class="px-5">
				{behind ?? (
					<>
						<TxHeader />
						<Days rows={[BLUE_BOTTLE, TRADER_JOES, COSTCO]} />
					</>
				)}
			</div>
			<div class="absolute inset-0 bg-ink/30" />
			<div class="absolute inset-x-0 bottom-0 flex max-h-full flex-col gap-3 overflow-y-auto rounded-t-sheet bg-paper p-5">
				{children}
			</div>
		</div>
	);
}

type TopProps = {
	row: ListRow;
	raw?: string;
	account: string;
	/** After the account on the day line (P79 C's "Paid the Rent bill"). */
	lineEnd?: Child;
};

/** The panel's top: the bank's text when it differs, the name, the amount, the day and account. */
export function PanelTop({ row, raw, account, lineEnd }: TopProps) {
	return (
		<div>
			{raw && <p class="text-sm text-muted">{raw}</p>}
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				{row.displayName}
			</h2>
			<p class="font-serif text-4xl font-semibold">
				{formatCents(row.amountCents, { signed: true })}
			</p>
			<p class="text-muted">
				{dayLabel(row.date, TODAY)} · {account}
				{lineEnd}
			</p>
		</div>
	);
}

/** The panel's form part, under its rule. */
export function PanelForm({ children }: { children?: Child }) {
	return (
		<div class="flex flex-col gap-4 border-t border-rule pt-4">{children}</div>
	);
}

type CatsProps = {
	p: string;
	cats: Cat[];
	selected?: string;
	/** Tally's guess: the first chip, dashed and marked Suggested until a person picks (P32 A). */
	maybe?: Cat;
	/** Goes last in the chip row (P67's New category). */
	end?: Child;
	/** Beside the "Category" label (P79 E's Why?). */
	labelEnd?: Child;
	/** After the chosen chip's name, while it's chosen (P79 D's "from the bill"). */
	selectedEnd?: Child;
	/** Lines under the chips. */
	children?: Child;
};

/** The category chips (the app shows every category; the pictures show a few). */
export function Categories({
	p,
	cats,
	selected,
	maybe,
	end,
	labelEnd,
	selectedEnd,
	children,
}: CatsProps) {
	return (
		<fieldset
			class="flex flex-col gap-2"
			aria-labelledby={labelEnd ? `${p}-cat-label` : undefined}
		>
			{labelEnd ? (
				<div class="flex items-center gap-2">
					<p id={`${p}-cat-label`} class="text-base text-ink">
						Category
					</p>
					{labelEnd}
				</div>
			) : (
				<legend class="text-base text-ink">Category</legend>
			)}
			<div class="flex flex-wrap gap-2">
				{maybe && (
					<span class="rounded-full border border-dashed border-ink">
						<Chip
							type="radio"
							name={`${p}-cat`}
							value={maybe.name}
							icon={<CategoryIcon icon={maybe.icon} color={maybe.color} />}
						>
							{maybe.name} · Suggested
						</Chip>
					</span>
				)}
				{cats
					.filter((c) => c.name !== maybe?.name)
					.map((c) => (
						<Chip
							type="radio"
							name={`${p}-cat`}
							value={c.name}
							checked={c.name === selected}
							icon={<CategoryIcon icon={c.icon} color={c.color} />}
						>
							{selectedEnd && c.name === selected ? (
								<span class="inline-flex items-center gap-1.5">
									{c.name}
									{selectedEnd}
								</span>
							) : (
								c.name
							)}
						</Chip>
					))}
				{end}
			</div>
			{children}
		</fieldset>
	);
}

type TogglesProps = { p: string; always?: boolean; dashed?: boolean };

/** The two toggle chips; the merchant one can be dashed, P32's "not decided yet" look. */
export function Toggles({ p, always, dashed }: TogglesProps) {
	const chip = (
		<Chip type="checkbox" name={`${p}-always`} value="1" checked={always}>
			Always for this merchant
		</Chip>
	);
	return (
		<div class="flex flex-wrap gap-2">
			{dashed ? (
				<span class="rounded-full border border-dashed border-ink">{chip}</span>
			) : (
				chip
			)}
			<Chip type="checkbox" name={`${p}-excluded`} value="1">
				Exclude from budget
			</Chip>
		</div>
	);
}

/** Cancel and Save, as the panel ends. */
export const actions = (
	<div class="grid grid-cols-2 gap-3">
		<Button kind="secondary" type="button" class="w-full">
			Cancel
		</Button>
		<Button type="button" class="w-full">
			Save
		</Button>
	</div>
);

type PanelProps = {
	p: string;
	row: ListRow;
	raw?: string;
	account?: string;
	cats?: Cat[];
	selected?: string;
	toggles?: Omit<TogglesProps, "p">;
	/** A muted line under the toggles. */
	note?: string;
	/** Last in the chip row (P67's New category). */
	catEnd?: Child;
	/** Under the chips (P67 B's link). */
	catNote?: Child;
	/** After the toggles (P68's rename disclosure). */
	after?: Child;
	/** Between the panel's top and its form. */
	children?: Child;
};

/** A panel for one transaction: its top, then chips, toggles, a line about them, and Save. */
function Panel(props: PanelProps) {
	const { p, cats = FIVE, selected = "Groceries" } = props;
	return (
		<PanelSheet>
			<PanelTop
				row={props.row}
				raw={props.raw}
				account={props.account ?? CARD}
			/>
			{props.children}
			<PanelForm>
				<Categories p={p} cats={cats} selected={selected} end={props.catEnd}>
					{props.catNote}
				</Categories>
				<div class="flex flex-col gap-2">
					<Toggles {...props.toggles} p={p} />
					{props.note && <p class="text-sm text-muted">{props.note}</p>}
				</div>
				{props.after}
				{actions}
			</PanelForm>
		</PanelSheet>
	);
}

// ---------------------------------------------------------------------------------------------
// P62: rule suggestions.

/** A: on the next Costco, the toggle shows dashed with how many times the category was picked. */
const ruleDashed = (
	<Panel
		p="p62-a"
		row={COSTCO}
		raw="COSTCO WHSE #0412"
		toggles={{ dashed: true }}
		note="You've picked Groceries for Costco 3 times. Tap to make it the rule."
	/>
);

type RuleQuestionProps = {
	/** What the save just did, in the quiet line at the top. */
	saved?: string;
	/** The one question, in the serif. */
	question?: string;
	/** What the question rests on, one plain line. */
	evidence?: string;
	/** The secondary answer and the primary one. */
	no?: string;
	yes?: string;
};

/**
 * B: the third save keeps the panel open with one question. P90 C asks a different question in
 * the same place, so its words are props; the defaults are P62 B's.
 */
export function RuleQuestion({
	saved = "Saved as Groceries",
	question = "Always use Groceries for Costco?",
	evidence = "You've picked Groceries for Costco 3 times. Say yes and Tally sorts the next one for you.",
	no = "Not now",
	yes = "Yes",
}: RuleQuestionProps) {
	return (
		<PanelSheet>
			<p role="status" class="flex items-center gap-2 text-muted">
				<Icon name="check" class="size-5" />
				{saved}
			</p>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				{question}
			</h2>
			<p>{evidence}</p>
			<div class="grid grid-cols-2 gap-3">
				<Button kind="secondary" type="button" class="w-full">
					{no}
				</Button>
				<Button type="button" class="w-full">
					{yes}
				</Button>
			</div>
		</PanelSheet>
	);
}

const ruleQuestion = <RuleQuestion />;

/** C: one item on the review screen, as P42 A asks it: the dashed "Maybe …" is the question. */
const ruleReview = (
	<>
		<a href="#p62-rule-suggestions" class="inline-flex min-h-11 items-center">
			Settings
		</a>
		<h1 class="sr-only">Suggestions</h1>
		<p class="text-muted">Suggestions · 4 of 9</p>
		<h2 class="mt-2 font-serif text-3xl font-semibold tracking-tight">
			Costco
		</h2>
		<p class="text-sm text-muted">COSTCO WHSE #0412</p>
		<p class="mt-1 text-lg">You've picked Groceries for it 3 times.</p>
		<div class="mt-5 border-t border-rule pt-5">
			<p>
				<span class="inline-flex items-center gap-2 rounded-control border border-dashed border-ink px-3 py-1 text-2xl">
					<CategoryIcon icon="groceries" color="cat-blue" />
					<span>
						Maybe a rule:{" "}
						<span class="whitespace-nowrap">Costco → Groceries</span>
					</span>
				</span>
			</p>
			<p class="mt-2 text-sm text-muted">
				Your picks: Sep 12, Sep 28 and Oct 3.
			</p>
		</div>
		<div class="mt-4 flex flex-col gap-3">
			<Button type="button" class="w-full">
				Yes, make it a rule
			</Button>
			<Button kind="secondary" type="button" class="w-full">
				Not now
			</Button>
		</div>
	</>
);

// ---------------------------------------------------------------------------------------------
// P63: filter by account.

const byAccount = (
	<Transactions
		p="p63-a"
		account={CARD}
		count={`12 transactions in ${CARD}, October`}
		rows={[BLUE_BOTTLE, COSTCO, AMAZON, SHELL]}
	/>
);

type AccountLinkProps = {
	name: string;
	mask: string;
	cents: number;
	credit?: boolean;
};

/** B: an account row that links to its transactions, with a chevron at its end like a Settings row. */
function AccountLink({ name, mask, cents, credit }: AccountLinkProps) {
	return (
		<li>
			<a
				href="#p63-account"
				class="flex h-16 items-center gap-4 text-ink no-underline"
			>
				<Icon name={credit ? "card" : "bank"} class="size-7 shrink-0" />
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg leading-6">{name}</span>
					<span class="block leading-6 text-muted">
						<span class="sr-only">ending in </span>
						<span aria-hidden="true">••</span>
						{mask}
					</span>
				</span>
				<span class="shrink-0 text-lg">{formatCents(cents)}</span>
				<Icon name="chevron-right" class="size-5 shrink-0" />
			</a>
		</li>
	);
}

const accountLinks = (
	<>
		<AccountsTop
			netWorthCents={2340000}
			history={netWorthViewEnding(2340000)}
		/>
		<p class="mt-4 text-muted">Tap an account to see its transactions.</p>
		<section class="mt-4">
			<h2 class="text-muted">Chase</h2>
			<ul class="mt-2 divide-y divide-rule border-y border-rule">
				<AccountLink name="Chase Checking" mask="4410" cents={624000} />
				<AccountLink name="Chase Savings" mask="8812" cents={1850000} />
				<AccountLink name="Chase Card" mask="9921" cents={-134000} credit />
			</ul>
		</section>
	</>
);

// ---------------------------------------------------------------------------------------------
// P64 to P66: the type filter and search.

const INCOME = "2 income transactions in October";
const typeChips = (
	<Transactions
		p="p64-a"
		type="Income"
		count={INCOME}
		rows={[PAYROLL, INTEREST]}
	/>
);
const typeShow = (
	<Transactions
		p="p64-b"
		show="Income"
		count={INCOME}
		rows={[PAYROLL, INTEREST]}
	/>
);

const searchAmount = (
	<Transactions
		p="p65-a"
		q="$42"
		count={`2 transactions matching "$42" (amounts $42.00 to $42.99) in October`}
		rows={[LUPITAS, AMAZON]}
	/>
);
const searchHint = (
	<Transactions
		p="p65-b"
		hint="Try a category or an amount."
		count="14 transactions in October"
		rows={[BLUE_BOTTLE, TRADER_JOES, LUPITAS, COSTCO]}
	/>
);

const searchAll = (
	<Transactions
		p="p66-a"
		q="costco"
		month="All months"
		count={`5 transactions matching "costco" in all months`}
		afterCount={
			<Button kind="text" href="#p66-search">
				Only October
			</Button>
		}
		rows={[COSTCO, ...OLDER_COSTCO]}
	/>
);

/** B: the month choice as a pair of links; the current one says so with a tick, not color alone. */
const monthLinks = (
	<p class="flex items-center gap-1">
		<span class="inline-flex min-h-11 items-center gap-1 px-2 font-medium">
			<Icon name="check" class="size-4" />
			This month
		</span>
		<a href="#p66-search" class="inline-flex min-h-11 items-center px-2">
			All months
		</a>
	</p>
);
const searchPair = (
	<Transactions
		p="p66-b"
		q="costco"
		underSearch={monthLinks}
		count={`1 transaction matching "costco" in October`}
		rows={[COSTCO]}
	/>
);

// ---------------------------------------------------------------------------------------------
// P67: a new category while categorizing.

type NewProps = { p: string; name: string };

/** The last chip: a disclosure that looks like a chip, and opens in place to a name field. */
function NewCategory({ p, name }: NewProps) {
	return (
		<details open class="open:w-full">
			<summary class="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-rule px-4 text-base text-accent [&::-webkit-details-marker]:hidden">
				<Icon name="plus" class="size-4" />
				New category
			</summary>
			<div class="pt-3">
				<TextInput
					id={`${p}-name`}
					label="New category name"
					value={name}
					hint="Added to your categories and used for this transaction."
					autocomplete="off"
					surface="paper"
				/>
			</div>
		</details>
	);
}

const newInPanel = (
	<Panel
		p="p67-a"
		row={CHEWY}
		cats={FOUR}
		selected=""
		catEnd={<NewCategory p="p67-a" name="Pet Care" />}
	/>
);

const newLink = (
	<Panel
		p="p67-b"
		row={CHEWY}
		cats={FOUR}
		selected=""
		catNote={
			<>
				<a
					href="#p67-new-category"
					class="inline-flex min-h-11 items-center self-start"
				>
					Add a category in Settings
				</a>
				<p class="text-sm text-muted">
					It brings you back to this transaction.
				</p>
			</>
		}
	/>
);

// ---------------------------------------------------------------------------------------------
// P68: rename one transaction only.

/** A: the name field, then how many it renames, inside today's "Rename or add a note" disclosure. */
const renameOne = (
	<Panel
		p="p68-a"
		row={AMAZON}
		raw="AMAZON MKTPL*2K4"
		cats={[HOUSEHOLD, GROCERIES]}
		selected="Household"
		after={
			<details open class="group border-t border-rule">
				<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
					<span class="transition-transform group-open:rotate-90 motion-reduce:transition-none">
						<Icon name="chevron-right" class="size-5" />
					</span>
					Rename or add a note
				</summary>
				<div class="flex flex-col gap-4 pt-2">
					<TextInput
						id="p68-a-name"
						label="Name"
						value="Dog bed"
						autocomplete="off"
						surface="paper"
					/>
					<fieldset class="flex flex-col gap-2">
						<legend class="text-base text-ink">Rename</legend>
						<div class="flex flex-wrap gap-2">
							<Chip type="radio" name="p68-a-scope" value="one" checked>
								This one only
							</Chip>
							<Chip type="radio" name="p68-a-scope" value="all">
								All 23 from Amazon
							</Chip>
						</div>
					</fieldset>
				</div>
			</details>
		}
	/>
);

/** B: a note shows on the row after the category; the name stays the merchant's. */
const renameNote = (
	<Transactions
		p="p68-b"
		q="amazon"
		count={`3 transactions matching "amazon" in October`}
		rows={[
			withNote(41, "2026-10-02", 4217, "Dog bed"),
			withNote(42, "2026-10-01", 2600, "Mia's birthday present"),
			withNote(43, "2026-10-01", 1899),
		]}
	/>
);

// ---------------------------------------------------------------------------------------------
// P69: see and remove merchant rules.

export const RULES: [string, Cat, number][] = [
	["Costco", GROCERIES, 23],
	["Shell", GAS, 31],
	["Trader Joe's", GROCERIES, 18],
	["Blue Bottle Coffee", EATING_OUT, 14],
];

/** The merchant rules as rows, each ending in a terracotta Remove (P88 draws them beside its own). */
export function RuleRows({
	rules = RULES,
}: {
	rules?: [string, Cat, number][];
}) {
	return (
		<ul class="mt-3 divide-y divide-rule border-y border-rule">
			{rules.map(([merchant, cat, n]) => (
				<li class="flex min-h-16 items-center gap-4 py-2">
					<CategoryIcon icon={cat.icon} color={cat.color} />
					<span class="min-w-0 flex-1">
						{/* No truncation: it would cut off the category, the point of the row. The arrow and
						    category stay together, so a long merchant name wraps before them. */}
						<span class="block text-lg leading-6">
							{merchant}{" "}
							<span class="whitespace-nowrap">
								<span aria-hidden="true">→ </span>
								<span class="sr-only">is always </span>
								{cat.name}
							</span>
						</span>
						<span class="block leading-6 text-muted">
							Always {cat.name} · {n} transactions
						</span>
					</span>
					<Button kind="text" type="button">
						Remove<span class="sr-only"> {merchant}</span>
					</Button>
				</li>
			))}
		</ul>
	);
}

/**
 * A: the section, drawn first on Settings so it fits; each row ends in a terracotta Remove. It's
 * named in the toggle's own words, not "Rules" (the owner's pick, decision 74).
 */
const rulesList = (
	<>
		<h1 class={TITLE}>Settings</h1>
		<section class="mt-8" aria-labelledby="p69-rules">
			<h2 id="p69-rules" class="font-serif text-3xl font-semibold">
				Always for these merchants
			</h2>
			<p class="mt-1 text-muted">Tally sorts these merchants for you.</p>
			<RuleRows />
		</section>
	</>
);

/** B: the toggle opens ticked when the merchant has a rule, and says what unticking does. */
const ruleToggle = (
	<Panel
		p="p69-b"
		row={COSTCO}
		raw="COSTCO WHSE #0412"
		toggles={{ always: true }}
		note="Costco is always Groceries. Untick it and save to stop."
	/>
);

// ---------------------------------------------------------------------------------------------
// P70: select all.

type SelectProps = {
	rows: ListRow[];
	checked: number[];
	aboveList?: Child;
	bar: Child;
	/** The result count above the list; P70's is September's. */
	count?: string;
};

/** Select mode, scrolled past its filters: the title, the count, the rows, and the action bar. */
export function SelectScreen({
	rows,
	checked,
	aboveList,
	bar,
	count = "Showing 1–25 of 112 transactions in September",
}: SelectProps) {
	return (
		<div class="relative -mx-5 h-[684px] overflow-hidden">
			<div class="px-5">
				<div class="flex items-center justify-between gap-3">
					<h1 class={TITLE}>Transactions</h1>
					<Button kind="text" type="button" class="-mr-2">
						Done
					</Button>
				</div>
				<p class="mt-2 text-sm text-muted">Tap rows to select them.</p>
				<p class="mt-4 text-sm text-muted">{count}</p>
				{aboveList}
				<div class="mt-2">
					<Days rows={rows} select checked={checked} />
				</div>
			</div>
			<div class="absolute inset-x-0 bottom-0 border-t border-ink bg-paper px-5 py-3">
				{bar}
			</div>
		</div>
	);
}

/** The last days of September, with ids from `base` so each picture's rows stay unique. */
const sept = (base: number) => [
	tx(base + 1, "2026-09-30", "Trader Joe's", 6140, GROCERIES),
	tx(base + 2, "2026-09-30", "Shell", 3825, GAS),
	tx(base + 3, "2026-09-29", "Blue Bottle Coffee", 650, EATING_OUT),
	tx(base + 4, "2026-09-29", "Lupita's Taqueria", 4290, EATING_OUT),
	tx(base + 5, "2026-09-28", "Costco", 15840, GROCERIES),
	tx(base + 6, "2026-09-28", "Chewy", 6412),
];

export const barButtons = (
	<>
		<Button kind="secondary" type="button" class="px-3">
			Set category
		</Button>
		<Button kind="secondary" type="button" class="px-3">
			Exclude
		</Button>
	</>
);

/** A: the bar's new line beside the count; it offers the page, then (once ticked) the whole month. */
export function SelectBar({
	selected,
	link,
}: {
	selected: number;
	link: string;
}) {
	return (
		<div class="flex flex-col gap-1">
			<div class="flex items-center justify-between gap-2">
				<span aria-live="polite" class="text-lg">
					{selected} selected
				</span>
				<Button kind="text" type="button">
					{link}
				</Button>
			</div>
			<div class="flex gap-2">{barButtons}</div>
		</div>
	);
}

/** B: a row of the list's own look that ticks every row on the page. */
const allOnPage = (
	<label class="group relative mt-3 flex min-h-11 cursor-pointer items-center gap-3 border-b border-rule">
		<input class="peer sr-only" type="checkbox" name="p70-b-all" />
		<span class="flex size-7 shrink-0 items-center justify-center rounded-full border border-muted peer-checked:border-ink peer-checked:bg-band">
			<span class="hidden group-has-[:checked]:flex">
				<Icon name="check" class="size-4" />
			</span>
		</span>
		<span class="text-lg">All 25 on this page</span>
	</label>
);

/** A, first: some rows ticked, and the bar offers the 25 on this page. */
const selectPage = (
	<SelectScreen
		rows={sept(100)}
		checked={[101, 103, 104]}
		bar={<SelectBar selected={3} link="Select all 25" />}
	/>
);
/** A, next: the page is ticked, and the bar offers the whole month. */
const selectAll = (
	<SelectScreen
		rows={sept(200)}
		checked={[201, 202, 203, 204, 205, 206]}
		bar={<SelectBar selected={25} link="Select all 112 in September" />}
	/>
);
const selectRow = (
	<SelectScreen
		rows={sept(300)}
		checked={[301, 303, 304]}
		aboveList={allOnPage}
		bar={
			<div class="flex flex-wrap items-center gap-2">
				<span aria-live="polite" class="mr-auto text-lg">
					3 selected
				</span>
				{barButtons}
			</div>
		}
	/>
);

// ---------------------------------------------------------------------------------------------
// P71: edit a cash transaction's date or amount.

/** A: a cash entry's panel shows the Add cash form's amount and date as fields. */
const cashFields = (
	<PanelSheet>
		<div>
			<h2 class="font-serif text-4xl font-semibold tracking-tight">
				Farmers market
			</h2>
			<p class="text-muted">Cash · you entered this</p>
		</div>
		<PanelForm>
			<MoneyInput
				id="p71-a-amount"
				name="amount"
				label="Amount"
				value="18.50"
			/>
			<TextInput
				id="p71-a-date"
				name="date"
				label="Date"
				type="date"
				value="2026-10-04"
				max={TODAY}
				surface="paper"
			/>
			<Categories p="p71-a" cats={THREE} selected="Groceries" />
			{actions}
		</PanelForm>
	</PanelSheet>
);

/** B: the panel stays read-only, with a link to the Add cash form filled in. */
const cashLink = (
	<Panel p="p71-b" row={FARMERS} account="Cash" cats={THREE}>
		<a
			href="#p71-cash"
			class="inline-flex min-h-11 items-center gap-1 self-start"
		>
			Edit date and amount
			<Icon name="chevron-right" class="size-4" />
		</a>
	</Panel>
);

/** Both: a bank's transaction keeps what the bank sent, and the panel says where to fix it. */
const bankReadOnly = (
	<Panel p="p71-bank" row={COSTCO} raw="COSTCO WHSE #0412" cats={THREE}>
		<p class="text-muted">
			From Chase. Its date and amount stay as the bank sent them. If something's
			off, you can split it, exclude it, or count it in another month.
		</p>
		<Button kind="secondary" type="button" class="w-full">
			Split
		</Button>
	</Panel>
);

/** P62–P71 on the proposals page, open for the owner's pick. */
export function Phase5TransactionsProposals() {
	return (
		<>
			<Specimen
				id="p62-rule-suggestions"
				title="P62 · Rule suggestions"
				tier="visual"
				sentence="After you give the same merchant the same category three times, Tally offers to make it that merchant's rule. Pick where the offer shows. Each is drawn with Costco, Groceries."
			>
				<Fixed>
					after a person gives the same merchant the same category three times,
					Tally offers to make it the merchant's rule (§8.4). A person's own
					choice outranks a rule (§7). Name, category, new-category, income and
					transfer suggestions show as one dashed “Maybe …” on one review screen
					(§8.6); a rule offer isn't on that list, so whether it joins is part
					of this pick.
				</Fixed>
				<NeedsLine settled="decisions 74, 79 and 80">
					The offer comes on the third save of one category for one merchant,
					and on every matching save after, until the merchant has a rule; Not
					now only skips that one. Only transactions a person put in that
					category for that merchant count, from any screen, counted from the
					transactions themselves, not “in a row”. A store whose trips a person
					has put in two or more categories gets no offer.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A dashed toggle in the panel",
							note: "The third save's toast says a rule is ready; whenever that merchant's panel is opened after, “Always for this merchant” shows dashed with the count, and one tap and Save makes the rule.",
							tradeoff:
								"a toast has no button, and the toggle is seen only if that merchant is opened again, which a rule is meant to make unnecessary.",
							screen: ruleDashed,
						},
						{
							name: "Option B · A question after the third save",
							picked: true,
							note: "The panel stays open with one question, “Always use Groceries for Costco?”, and Yes or Not now. Picked to ask on the third matching save and every one after, until there's a rule.",
							tradeoff:
								"one more step on the third save, even in a hurry, once for each merchant.",
							recommended:
								"it asks at the one moment the person has just shown the pattern, and yes is one tap; A's offer is seen only if that merchant is opened again.",
							screen: ruleQuestion,
						},
						{
							name: "Option C · On the review screen",
							note: "“Maybe a rule: Costco → Groceries” waits with the other suggestions and is answered one at a time.",
							tradeoff:
								"it fits the one Maybe pattern, but it isn't a guess (code counts your picks), and it waits for a trip to Settings, long after the third pick.",
							screen: ruleReview,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p63-account-filter"
				title="P63 · Filter by account"
				tier="visual"
				sentence="Show only one account's transactions. Pick where you choose the account."
			>
				<Fixed>
					a filter by account shows only one account's transactions (§8.4). The
					count above the list names every active filter, so a change is
					announced (DESIGN.md, Result count).
				</Fixed>
				<NeedsLine>
					how the count names an account with a category. Proposed: “in
					Groceries, Chase Card ••9921, October”; the Cash account reads “Cash”.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · An Account filter",
							picked: true,
							note: "An Account choice beside Month and Category; the count names it.",
							tradeoff:
								"one more control, and on a phone the filters wrap to another row, so the list starts lower.",
							recommended:
								"it works with search, category and month like every other filter, and the count says which account.",
							screen: byAccount,
						},
						{
							name: "Option B · From Accounts",
							note: "Each account row links to its transactions, with the account named in the count.",
							tradeoff:
								"you can't switch accounts from the list, only by going back.",
							screen: accountLinks,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p64-type-filter"
				title="P64 · Filter by type"
				tier="visual"
				sentence="Income, refunds and transfers are hard to find today. Pick how to filter by type. Each is drawn with Income chosen."
			>
				<Fixed>
					income counts only toward Income, never Spent, and a refund linked to
					its purchase counts in the purchase's month and category (§6). The
					Excluded filter shows only excluded transactions (§8).
				</Fixed>
				<NeedsLine>
					what Spending, Income and Excluded each hold (proposed: Spending is
					counted and not income; Income is flagged income; Excluded is left out
					of the budget, where transfers and card payments go). Already settled
					(decisions 74 and 79): the Show choice for type has all, spending,
					income, refunds and excluded, and replaces the Excluded filter;
					Refunds holds money in that isn't income or a transfer, so money in
					that nothing explains lands there.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Type chips",
							note: "All, Spending, Income, Refunds and Excluded in a row of chips; Excluded moves in from where it is today.",
							tradeoff:
								"on a phone the chips take two more rows, so the list starts lower.",
							recommended:
								"every type is one tap away and in view, and Excluded stays where people look for it.",
							screen: typeChips,
						},
						{
							name: "Option B · A Show choice",
							picked: true,
							note: "One Show choice beside Month and Category holds the same five; Excluded leaves the chips.",
							tradeoff: "the types stay hidden until you open the choice.",
							screen: typeShow,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p65-search-more"
				title="P65 · Search by category or amount"
				tier="visual"
				sentence="Search finds a merchant's name, but not “groceries” or “42.17”. Pick how it shows what it can find."
			>
				<Fixed>
					search matches the merchant name, raw name and note (§8), and money is
					integer cents (§5).
				</Fixed>
				<NeedsLine>
					whether a whole number typed without $ (“42”) also matches $42.00 to
					$42.99 (proposed: yes, with or without $). Already settled (decisions
					74 and 79): a word also matches a category's name; “$42” finds
					anything from $42.00 to $42.99, and the count says what matched; and a
					number matches an amount, money out and money in alike (“42.17” finds
					a $42.17 purchase and a $42.17 refund).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Search matches both, and says so",
							picked: true,
							note: "“$42” finds $42.00 to $42.99, and the count says what matched; “groceries” finds the category, and says “(category)”.",
							tradeoff: "a longer count line.",
							recommended:
								"it adds no control: the count already names every filter, and now it says why a row matched.",
							screen: searchAmount,
						},
						{
							name: "Option B · A hint under the box",
							note: "The same matching, with a muted hint under the box and the count as it is today.",
							tradeoff:
								"it says what works, but a row that matched by amount doesn't say why, and the hint stays after you know it.",
							screen: searchHint,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p66-search-months"
				title="P66 · Search every month"
				tier="visual"
				sentence="Search looks only at this month, so last month's charge looks missing. Pick how to search further back. Each is drawn with “costco”."
			>
				<Fixed>
					a search across all months is in Phase 5 (§8.4, decision 67), and the
					count names every active filter, the month included (DESIGN.md, Result
					count).
				</Fixed>
				<NeedsLine>
					what picking a month does, and what clearing the search does, while a
					search is typed (proposed: picking a month narrows it; clearing the
					search returns to this month). Already settled (decision 74): a search
					looks in every month, with an “Only October” link to narrow.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Search looks everywhere",
							picked: true,
							note: "A search switches the month to All months, the count says so, and “Only October” narrows it.",
							tradeoff:
								"a search can list more than you expected; the link narrows it.",
							recommended:
								"last month's charge is found the first time, with nothing new to learn: the count says what was searched.",
							screen: searchAll,
						},
						{
							name: "Option B · This month or All months",
							note: "A pair of links under the search box: This month, ticked, and All months.",
							tradeoff:
								"a first search still misses last month until you tap, and it repeats the month choice.",
							screen: searchPair,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p67-new-category"
				title="P67 · A new category while categorizing"
				tier="visual"
				sentence="The strongest complaint from the beta: you can't add a category at the moment you need one. Pick how. Each is drawn with Chewy, which has no category yet."
			>
				<Fixed>
					at most 50 categories are active, names are unique ignoring case
					(archived ones included), and none is “None of these fit”. A new one
					gets the tag icon and the next color (§7).
				</Fixed>
				<NeedsLine>
					what Save does with a new name. Proposed: it wins over any chip; a
					taken name, or a 51st category, shows an error in the field and saves
					nothing; the new one goes last in the order.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A “New category” chip",
							picked: true,
							note: "The last chip opens a name field in place; one Save makes the category and files this transaction. Organize ends its chips the same way.",
							tradeoff: "the chip row gets one more chip.",
							recommended:
								"you never leave the panel at the moment of categorizing, and one Save finishes both.",
							screen: newInPanel,
						},
						{
							name: "Option B · A link to Settings",
							note: "“Add a category in Settings” under the chips, then it brings you back here.",
							tradeoff:
								"you leave the panel, and a name or note you typed is lost.",
							screen: newLink,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p68-rename-one"
				title="P68 · Rename one transaction only"
				tier="visual"
				sentence="Renaming a merchant renames every transaction from it, which is wrong for Amazon or PayPal. Pick how to name just one."
			>
				<Fixed>
					renaming a merchant renames every transaction from that merchant,
					because display names are looked up from merchants (§7); a person's
					own rename always wins over a suggested or tidied name.
				</Fixed>
				<NeedsLine>
					which choice starts ticked (proposed: This one only; today's behavior
					is All) and whether search matches both names. Already settled
					(decisions 74 and 79): a name kept on one transaction is its own_name,
					shown in place of its merchant's name and on its split's parts; the
					merchant's name and the bank's text stay as they are.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Choose how many",
							picked: true,
							note: "Under the name field: “This one only” or “All 23 from Amazon”.",
							tradeoff: "one more choice in a panel that's already full.",
							recommended:
								"it fixes the name where it's typed, and says how many it changes before you save.",
							screen: renameOne,
						},
						{
							name: "Option B · The note names it",
							note: "No new choice: a note shows on the row, after the category.",
							tradeoff:
								"the name still says Amazon, so it's a caption, not a rename.",
							screen: renameNote,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p69-merchant-rules"
				title="P69 · See and remove merchant rules"
				tier="visual"
				sentence="“Always for this merchant” opens unticked even when a rule exists, and there's no list of rules. Pick where rules are seen."
			>
				<Fixed>
					a merchant's rule is its default category, made by “Always use this
					category for this merchant”; a person's own choice outranks it, and a
					rule on an archived category is skipped until it's restored (§7).
				</Fixed>
				<NeedsLine>
					what saving the toggle unticked does (proposed: it removes the rule),
					that removing a rule never changes a transaction already sorted, what
					the EmptyState says when there are no rules and how the list marks a
					rule on an archived category (proposed: paused). Already settled
					(decisions 54, 79 and 80, and DESIGN.md's empty-list rule): an empty
					list is an EmptyState; in the edit panel the toggle is ticked when the
					chosen category is the rule's and unticked when it isn't, and ticking
					it makes the new category the rule; the list is A to Z, with a search
					box once there are more than 20.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · A Rules list in Settings",
							picked: true,
							note: "Picked, named “Always for these merchants”: each is a row, “Costco → Groceries”, with Remove; the panel's toggle also opens ticked when a rule exists, as in B.",
							tradeoff:
								"one more section on a Settings page that's already long.",
							recommended:
								"you see every rule in one place and can remove one without finding a transaction first.",
							screen: rulesList,
						},
						{
							name: "Option B · Only in the panel",
							note: "The toggle shows ticked when a rule exists; unticking it and saving removes the rule.",
							tradeoff:
								"you can only find a rule by opening a transaction from that merchant.",
							screen: ruleToggle,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p70-select-all"
				title="P70 · Select all"
				tier="visual"
				sentence="In Select mode you tick every row by hand. Pick how to tick them all."
			>
				<Fixed>
					Select mode, with Set category and Exclude on a bar pinned at the
					bottom, is built (§8.2); Select all is in Phase 5 (§8.4, decision 67).
				</Fixed>
				<NeedsLine>
					how “all 112” is applied. Bulk actions take at most 100 rows today (D1
					binds 100 values), so it would send the filters and the ids of any
					rows the person unticked afterward, not every selected id: the server
					changes everything the filters match at that moment except those
					unticked rows, skips split parents, and says how many. Already settled
					(decisions 79 and 80): unticking a row after Select all leaves the
					rest selected (“111 selected”).
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Select all in the action bar",
							picked: true,
							note: "A link beside the count: “Select all 25” ticks the page.",
							tradeoff: "the bar grows a second line.",
							recommended:
								"the count and the actions are already in the bar, and a second link reaches the whole month.",
							screen: selectPage,
						},
						{
							name: "Option A, next · The whole month",
							note: "Once the page is ticked, the link offers “Select all 112 in September” (September, because October has only 5 days so far).",
							screen: selectAll,
						},
						{
							name: "Option B · An “All on this page” row",
							note: "A row above the list ticks every row on the page.",
							tradeoff:
								"it stops at the page's 25, and it's a row in the list.",
							screen: selectRow,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p71-cash-edit"
				title="P71 · Edit a cash transaction's date or amount"
				tier="visual"
				sentence="A cash entry you typed in can be wrong. Pick how to fix its date or amount; a bank's never changes."
			>
				<Fixed>
					only hand-entered (Cash account) transactions can have a date or
					amount edited; a bank's keeps the bank's, so sync never fights a
					person (§8.4).
				</Fixed>
				<NeedsLine>
					whether a date can be in the future (proposed: it can't be). Already
					settled (decisions 58, 60 and 79, and §6): a changed entry counts in
					its new date's month, or, while it is linked, in the month of the
					earlier bill occurrence it pays or of the purchase it refunds; a split
					cash entry's new date moves to its parts, and a new amount that no
					longer matches its parts can't be saved until the parts are corrected,
					so the split is never reset. Its links (a bill payment, a refund) are
					kept: a new date keeps them, and a new amount is checked by the same
					guards as linking and refused with a field error if it breaks one.
				</NeedsLine>
				<Options
					options={[
						{
							name: "Option A · Fields in the panel",
							picked: true,
							note: "A cash entry's panel shows the Add cash form's amount and date as fields, under “Cash · you entered this”.",
							tradeoff: "the panel is taller, and Save does more.",
							recommended:
								"one place and one Save, with the amount field you already know from Add cash.",
							screen: cashFields,
						},
						{
							name: "Option B · An “Edit date and amount” link",
							note: "The panel stays read-only; a link opens the Add cash form with its fields filled in.",
							tradeoff: "a second screen for one fix.",
							screen: cashLink,
						},
						{
							name: "Both · A bank transaction",
							note: "Its date and amount stay as the bank sent them, and the panel says where to fix a wrong one.",
							screen: bankReadOnly,
						},
					]}
				/>
			</Specimen>
		</>
	);
}
