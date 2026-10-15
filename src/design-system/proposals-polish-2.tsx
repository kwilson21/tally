// P118 and P119 (#497 and #71, decision 47): the polish track's choices, drawn so the owner can
// pick by seeing. P118 is how a row shows it opens. P119 is how the row you just saved shows it
// changed. Today's pictures are the real components. Each option is a copy of them that changes only
// what the option changes, so the pictures compare like with like. The owner's picks (decision 111)
// are marked Picked.

import type { Child } from "hono/jsx";
import { dayLabel } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { AdjustLink } from "../views/adjust-link";
import { Band } from "../views/band";
import { barGeometry } from "../views/bar";
import { CategoryIcon } from "../views/category";
import { Icon } from "../views/icons";
import { BottomTabs, type NavKey } from "../views/nav";
import { ProgressRow } from "../views/progress-row";
import { TICK_PATH } from "../views/saved-tick";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { rowCaption, TransactionRow } from "../views/transaction-row";
import { DesktopFrame, Fixed, PickedPill } from "./proposal-parts";
import {
	EATING_OUT,
	GROCERIES,
	HOUSEHOLD,
	tx,
} from "./proposals-phase5-transactions";
import { PhoneFrame, Specimen } from "./specimen";

/** Today in the sample, so the day heading reads "Today, Oct 13". */
const TODAY = "2026-10-13";

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style. Ids from 2001 keep these rows' ids apart from the other pictures.

const PAYCHECK = tx(2001, TODAY, "Paycheck", -245000, undefined, {
	income: true,
	rawName: "ACME CORP",
});
const FARMERS = tx(2002, TODAY, "Farmers market", 2000, GROCERIES);
const DOORDASH = tx(2003, TODAY, "Doordash taco", 3107, undefined, {
	rawName: "DD *DOORDASH TACO",
});
const WATER = tx(2004, TODAY, "City Water", 1399, HOUSEHOLD, {
	paysBill: true,
	billName: "Water",
});
const BAKERY = tx(2005, TODAY, "Local Bakery", 1200, undefined, {
	rawName: "SQ *LOCAL BAKERY 4432",
});
const BANFIELD = tx(2006, TODAY, "Banfield Pet Hospital", 18900, undefined, {
	rawName: "BANFIELD #1182",
});
/** Local Bakery once it is saved as Eating Out (P119). */
const BAKERY_SAVED = tx(2005, TODAY, "Local Bakery", 1200, EATING_OUT, {
	rawName: "SQ *LOCAL BAKERY 4432",
});
const SIX = [PAYCHECK, FARMERS, DOORDASH, WATER, BAKERY, BANFIELD];

type Budget = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};
/** October so far: Eating Out is over, and Gas is nearly spent (ProgressRow's own rules). */
const GROCERIES_ROW: Budget = {
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
	spentCents: 39500,
	budgetCents: 70000,
};
const EATING_ROW: Budget = {
	name: "Eating Out",
	icon: "eating-out",
	color: "cat-plum",
	spentCents: 28600,
	budgetCents: 25000,
};
const GAS_ROW: Budget = {
	name: "Gas",
	icon: "gas",
	color: "cat-slate",
	spentCents: 18600,
	budgetCents: 20000,
};
const KIDS_ROW: Budget = {
	name: "Kids",
	icon: "kids",
	color: "cat-ochre",
	spentCents: 21000,
	budgetCents: 30000,
};
const BUDGET = [GROCERIES_ROW, EATING_ROW, GAS_ROW, KIDS_ROW];
/** Groceries once it is saved at $650 (P119's Home still). */
const GROCERIES_SAVED: Budget = { ...GROCERIES_ROW, budgetCents: 65000 };

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });
const budgetHref = (i: number) => `/budget/${i + 1}`;
const transactionHref = (id: number) => `/transactions/${id}`;

// ---------------------------------------------------------------------------------------------
// The shared pieces. Each prototype below is copied from the real component's markup.

/** P118's two options: a row with an arrow (quiet), or with none (say). Needs category is muted in both. */
type Look = "quiet" | "say";

/** The arrow every row that opens ends in (P118 A): hung into the margin so its tip is the content's edge. */
const ARROW = "size-5 shrink-0 -ml-3 -mr-2 text-muted";

/**
 * A transaction row as TransactionRow draws it, copied with what the option changes: an arrow after
 * the amount (quiet), or none (say). `press` holds the row's box in the press tint (P118's pressed group
 * only). `end` takes the arrow's place (P119's tick); `li` is the saved row's own class (P119's press).
 */
function TxRow({
	row,
	look,
	press = false,
	end,
	li = "",
}: {
	row: ListRow;
	look: Look;
	press?: boolean;
	end?: Child;
	li?: string;
}) {
	const { kind, caption, tag } = rowCaption(row);
	const amount = formatCents(row.amountCents, { signed: true });
	// Needs category is quiet words that are never cut off. The dot and its spaces are one run with the
	// bank text, which is the only part that truncates; the non-breaking spaces keep one space each side.
	const said =
		tag && kind === "needs" ? (
			<span class="flex min-w-0 leading-6">
				<span class="shrink-0 text-muted">Needs category</span>
				{caption && (
					<span class="min-w-0 truncate text-muted">{` · ${caption}`}</span>
				)}
			</span>
		) : (
			caption && <span class="min-w-0 truncate text-muted">{caption}</span>
		);
	const icon =
		kind === "category" ? (
			<CategoryIcon
				icon={row.categoryIcon ?? ""}
				color={row.categoryColor ?? ""}
			/>
		) : (
			<span class={`shrink-0 ${kind === "income" ? "text-ink" : "text-muted"}`}>
				<Icon
					name={kind === "income" ? "income" : "circle-dashed"}
					class="size-7"
				/>
			</span>
		);
	return (
		<li data-transaction={row.id} class={`relative ${li}`}>
			<a
				href={transactionHref(row.id)}
				class={`flex h-16 items-center gap-4 text-ink no-underline ${press ? "bg-press" : ""}`}
			>
				{icon}
				<span class="min-w-0 flex-1">
					<span class="block truncate text-lg leading-6">
						{row.displayName}
					</span>
					<span class="flex min-w-0 items-center gap-2 leading-6">{said}</span>
				</span>
				<span class="shrink-0 text-lg">{amount}</span>
				{look === "quiet" &&
					(end ?? <Icon name="chevron-right" class={ARROW} />)}
			</a>
		</li>
	);
}

/** ProgressRow's 4px bar, still: the track, the fill, and brick, the near-limit colour or green. */
function Bar({ row, class: cls }: { row: Budget; class: string }) {
	const over = row.spentCents > row.budgetCents;
	const nearLimit =
		!over &&
		row.budgetCents > 0 &&
		row.spentCents >= 0 &&
		row.spentCents * 5 >= row.budgetCents * 4;
	const { fillPct } = barGeometry(row.spentCents, row.budgetCents);
	return (
		<svg class={cls} aria-hidden="true">
			<rect width="100%" height="100%" rx="2" class="fill-rule" />
			<rect
				width={`${fillPct}%`}
				height="100%"
				rx="2"
				class={over ? "fill-over" : nearLimit ? "fill-near-limit" : "fill-ok"}
			/>
		</svg>
	);
}

/**
 * A budget row as ProgressRow draws it, copied with what the option changes: the arrow on the name's
 * line, outside the text (quiet), or none (say). `end` takes the arrow's place (P119 A's tick), and `li`
 * is the row's own class (P119 B's press).
 */
function BudgetRow({
	row,
	href,
	look,
	end,
	li = "",
}: {
	row: Budget;
	href: string;
	look: Look;
	end?: Child;
	li?: string;
}) {
	const over = row.spentCents > row.budgetCents;
	const overBy = row.spentCents - row.budgetCents;
	const nearLimit = !over && row.spentCents * 5 >= row.budgetCents * 4;
	return (
		<li class={`relative ${li}`}>
			<a href={href} class="flex items-start gap-4 py-3 text-ink no-underline">
				<CategoryIcon icon={row.icon} color={row.color} />
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-baseline justify-between gap-x-3">
						<span class="text-lg">{row.name}</span>
						<span class="ml-auto text-right text-lg">
							{whole(row.spentCents)} of {whole(row.budgetCents)}
							{nearLimit && <span class="sr-only">, nearly spent</span>}
						</span>
					</div>
					<Bar row={row} class="mt-2 h-1 w-full" />
					{over && (
						<p class="mt-1 flex items-center justify-end gap-1 text-over">
							<Icon name="alert" class="size-5" />
							{formatCents(overBy, { wholeDollars: overBy % 100 === 0 })} over
							<span class="sr-only"> budget</span>
						</p>
					)}
				</div>
				{look === "quiet" &&
					(end ?? (
						<Icon name="chevron-right" class={`self-start mt-1 ${ARROW}`} />
					))}
			</a>
		</li>
	);
}

/** Home's Budget list as its section draws it: the heading with Adjust, a hint line, the rows. */
function BudgetBlock({ hint, children }: { hint?: Child; children?: Child }) {
	return (
		<div class="mt-8">
			<div class="flex items-baseline justify-between gap-4">
				<h2 class="font-serif text-3xl font-semibold">Budget</h2>
				<AdjustLink adjusting={false} />
			</div>
			{hint}
			<ul class="mt-2 divide-y divide-rule">{children}</ul>
		</div>
	);
}

/** The Transactions day: the hint above it (C), the day heading, and its rows. */
function TxDay({ hint, children }: { hint?: Child; children?: Child }) {
	return (
		<>
			{hint}
			<p class="mt-3 text-sm text-muted">{dayLabel(TODAY, TODAY)}</p>
			<ul class="divide-y divide-rule">{children}</ul>
		</>
	);
}

/** P118's rows as the real components draw them now (A is built): the arrow, Needs category in words, nothing pressed. */
const todayRows = (rows: ListRow[]) =>
	rows.map((r) => <TransactionRow row={r} href={transactionHref(r.id)} />);

/** P118's budget rows as the real ProgressRow draws them today. */
const todayBudget = () =>
	BUDGET.map((r, i) => <ProgressRow {...r} href={budgetHref(i)} />);

/** P118 A's six rows, quiet, with nothing pressed (the press is the pressed group's alone). */
const quietRows = () => SIX.map((r) => <TxRow row={r} look="quiet" />);

// ---------------------------------------------------------------------------------------------
// Stills: one 390 crop each, a phone's crop with the real tab bar drawn at the bottom. The toast sits
// 12px above that bar, where #toasts puts it. A still is a picture: labelled, inert, nothing to tap.

const SIZE = {
	short: "h-[216px]",
	crop: "h-[438px]",
	home: "h-[608px]",
} as const;

/** The 390 still, its crop, its tab bar and its toast. `loop` gives its replay the five-second loop (P119). */
function Still({
	label,
	size = "crop",
	loop = false,
	tab = "transactions",
	toast,
	children,
}: {
	label: string;
	size?: keyof typeof SIZE;
	loop?: boolean;
	tab?: NavKey;
	toast?: Child;
	children?: Child;
}) {
	return (
		<div
			role="img"
			aria-label={label}
			class={`relative ${loop ? "proposal-saved-loop " : ""}${SIZE[size]} w-[390px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper`}
		>
			<div inert class="px-5 pt-4">
				{children}
			</div>
			{/* The real BottomTabs, held in the still: static, not fixed to the window, and shown at every width. */}
			<div
				inert
				class="absolute inset-x-0 bottom-0 [&_nav]:static [&_nav]:block"
			>
				<BottomTabs active={tab} />
			</div>
			{toast && (
				<div class="absolute inset-x-4 bottom-[calc(var(--tabs-height)+0.75rem)] flex justify-center">
					{toast}
				</div>
			)}
		</div>
	);
}

/** A toast as #toasts draws it: the same words and border, flat (its shadow is toast.js's alone). */
function Toast({
	class: cls = "",
	children,
}: {
	class?: string;
	children?: Child;
}) {
	return (
		<p
			role="status"
			class={`rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink ${cls}`}
		>
			{children}
		</p>
	);
}

/**
 * The pencil tick (P119 A): a filled, tapered mark in ink, turned −8° in a 24px box. At 0 s only its
 * short arm shows (`short` clips the box to the arm, about 28% of the stroke's length); whole from 1 s.
 * `replay` leaves the draw and the lift to the loop, and sits over the arrow in the same box.
 */
function Tick({
	short = false,
	replay = false,
}: {
	short?: boolean;
	replay?: boolean;
}) {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			class={`size-6 -rotate-[8deg] text-ink ${replay ? "proposal-saved-tick absolute inset-0 opacity-0" : "block"} ${short ? "[clip-path:inset(0_63%_0_0)]" : ""}`}
		>
			<path fill="currentColor" d={TICK_PATH} />
		</svg>
	);
}

/**
 * The slot a tick takes: a 24px box whose negative margins net its width to the arrow's (none), centred
 * on the arrow's 20px slot, so the row never shifts. `cls` places it in a budget row.
 */
function TickSlot({ cls = "", children }: { cls?: string; children?: Child }) {
	return (
		<span class={`relative block size-6 shrink-0 -ml-3.5 -mr-2.5 ${cls}`}>
			{children}
		</span>
	);
}

// ---------------------------------------------------------------------------------------------
// P118 · How a row shows it opens.

type Choice = {
	name: string;
	note: string;
	cost?: string;
	why?: string;
	recommended?: boolean;
	picked?: boolean;
	desktop?: boolean;
	picture: Child;
};

/** The options side by side, each named, weighed and drawn: the Options layout, with a reason for each. */
function Choices({ choices }: { choices: Choice[] }) {
	return (
		<div class="flex flex-wrap gap-8">
			{choices.map((c) => (
				<div
					class={`flex ${c.desktop ? "w-[722px]" : "w-[392px]"} max-w-full flex-col gap-2`}
				>
					<div class="flex flex-col gap-1">
						<h4 class="flex flex-wrap items-center gap-x-2 font-semibold">
							{c.name}
							{c.recommended && (
								<span class="rounded-full border border-ink px-2.5 py-0.5 text-sm font-medium">
									Recommended
								</span>
							)}
							{c.picked && <PickedPill />}
						</h4>
						<p class="text-sm">{c.note}</p>
						{c.cost && <p class="text-sm text-muted">Trade-off: {c.cost}</p>}
						{c.why && <p class="text-sm text-muted">Why: {c.why}</p>}
					</div>
					{c.desktop ? (
						<DesktopFrame label={`${c.name}, on desktop`}>
							<div data-screen="picture">{c.picture}</div>
						</DesktopFrame>
					) : (
						<PhoneFrame label={`${c.name}, on a phone`} tall>
							<div data-screen="picture">{c.picture}</div>
						</PhoneFrame>
					)}
				</div>
			))}
		</div>
	);
}

/** The Transactions crop, then a dashed rule and the Home label, then the Budget part: one option's phone. */
function PhoneCrops({
	rows,
	budget,
	hint,
	budgetHint,
}: {
	rows: Child;
	budget: Child;
	hint?: Child;
	budgetHint?: Child;
}) {
	return (
		<>
			<TxDay hint={hint}>{rows}</TxDay>
			<div class="mt-8 border-t border-dashed border-rule pt-3">
				<p class="text-sm text-muted">Home</p>
			</div>
			<BudgetBlock hint={budgetHint}>{budget}</BudgetBlock>
		</>
	);
}

/** The three pressed crops, two rows each, and Select mode's, in the same column layout as Choices. */
function Crops({
	items,
}: {
	items: { name: string; note: string; picture: Child }[];
}) {
	return (
		<div class="flex flex-wrap gap-8">
			{items.map((c) => (
				<div class="flex w-[392px] max-w-full flex-col gap-2">
					<div class="flex flex-col gap-1">
						<h4 class="font-semibold">{c.name}</h4>
						<p class="text-sm">{c.note}</p>
					</div>
					<div class="overflow-x-auto">
						<div data-screen="picture">
							<Still label={`${c.name}, on a phone`} size="short">
								{c.picture}
							</Still>
						</div>
					</div>
				</div>
			))}
		</div>
	);
}

const TAP_TX = "Choose a transaction to change it.";
const TAP_BUDGET = "Choose a budget to change it.";

const todayPicture = (
	<PhoneCrops rows={todayRows(SIX)} budget={todayBudget()} />
);

const quietPicture = (
	<PhoneCrops
		rows={quietRows()}
		budget={BUDGET.map((r, i) => (
			<BudgetRow row={r} href={budgetHref(i)} look="quiet" />
		))}
	/>
);

const sayPicture = (
	<PhoneCrops
		hint={<p class="pb-2 text-sm text-muted">{TAP_TX}</p>}
		rows={SIX.map((r) => <TxRow row={r} look="say" />)}
		budgetHint={<p class="mt-1 text-sm text-muted">{TAP_BUDGET}</p>}
		budget={BUDGET.map((r, i) =>
			r === GROCERIES_ROW ? (
				<BudgetRow row={r} href={budgetHref(i)} look="say" />
			) : (
				<ProgressRow {...r} />
			),
		)}
	/>
);

/** Today's two rows held down and Select mode's, for the pressed group under P118's options. */
const pressedToday = (
	<ul class="divide-y divide-rule">
		<TransactionRow row={WATER} href={transactionHref(WATER.id)} />
		<TransactionRow row={BAKERY} href={transactionHref(BAKERY.id)} />
	</ul>
);
const pressedQuiet = (
	<ul class="divide-y divide-rule">
		<TxRow row={WATER} look="quiet" />
		<TxRow row={BAKERY} look="quiet" press />
	</ul>
);
const pressedSelect = (
	<ul class="divide-y divide-rule">
		<SelectableTransactionRow row={WATER} today={TODAY} />
		<SelectableTransactionRow row={BAKERY} checked today={TODAY} />
	</ul>
);

// ---------------------------------------------------------------------------------------------
// P119 · How the row you just saved shows it changed. Each still is the Transactions crop after
// saving Local Bakery as Eating Out, at a moment in the save; the Home still is the Groceries row
// saved at $650, one second in. The effects are frozen with static classes, except the replay.

type Option = "today" | "tick" | "let-go";
type Moment = "0s" | "1s" | "end" | "replay" | "keyboard";

const SAVED_TOAST = "Saved Local Bakery";
const SAVED_BUDGET_TOAST = "Saved the Groceries budget";

/** The toast at each moment: drawn whole at 0 s and 1 s, gone at 4 s, and its replay. */
function savedToast(moment: Moment, text: string) {
	if (moment === "end") return undefined;
	if (moment === "replay")
		return <Toast class="proposal-saved-toast opacity-0">{text}</Toast>;
	return <Toast>{text}</Toast>;
}

/**
 * The arrow's place when a tick takes it (P119 A): the short arm at 0 s, the whole tick at 1 s, the
 * arrow back at 4 s, and in the replay the arrow and the tick crossing in one slot. `cls` places it.
 */
function tickSlot(moment: Moment, cls = "") {
	if (moment === "end") return undefined;
	if (moment === "0s")
		return (
			<TickSlot cls={cls}>
				<Tick short />
			</TickSlot>
		);
	if (moment === "1s")
		return (
			<TickSlot cls={cls}>
				<Tick />
			</TickSlot>
		);
	return (
		<TickSlot cls={cls}>
			<Icon
				name="chevron-right"
				class="proposal-saved-chevron absolute inset-0.5 size-5 text-muted"
			/>
			<Tick replay />
		</TickSlot>
	);
}

/** The let-go row's press at each moment (P119 B): pressed through 1 s, faded from the replay's 1.3 s hold. */
function pressTint(moment: Moment) {
	if (moment === "end") return "";
	return moment === "replay" ? "proposal-saved-press" : "bg-press";
}

/** The saved row as one option draws it at one moment. */
function savedRow(option: Option, moment: Moment) {
	if (option === "tick")
		return <TxRow row={BAKERY_SAVED} look="quiet" end={tickSlot(moment)} />;
	if (option === "let-go")
		return <TxRow row={BAKERY_SAVED} look="quiet" li={pressTint(moment)} />;
	const href = transactionHref(BAKERY_SAVED.id);
	// Today: nothing on touch. The keyboard still draws the focus ring on the saved row.
	if (moment === "keyboard")
		return (
			<li class="outline-2 outline-offset-2 outline-accent">
				<TransactionRow row={BAKERY_SAVED} href={href} bare />
			</li>
		);
	return <TransactionRow row={BAKERY_SAVED} href={href} />;
}

/** The Transactions crop after the save: the rows around the saved one, as the option draws them. */
function savedCrop(option: Option, moment: Moment) {
	const quiet = option !== "today";
	const around = (r: ListRow) =>
		quiet ? (
			<TxRow row={r} look="quiet" />
		) : (
			<TransactionRow row={r} href={transactionHref(r.id)} />
		);
	return (
		<Still
			label={`${optionName(option)}, ${momentWords(moment)}`}
			loop={moment === "replay"}
			toast={savedToast(moment, SAVED_TOAST)}
		>
			<TxDay>
				{around(DOORDASH)}
				{around(WATER)}
				{savedRow(option, moment)}
				{around(BANFIELD)}
			</TxDay>
		</Still>
	);
}

/** The Home still a second after the Groceries budget is saved at $650. */
function savedHome(option: Option) {
	const rows = (r: Budget, i: number) => {
		const href = budgetHref(i);
		const groceries = i === 0;
		if (option === "tick")
			return (
				<BudgetRow
					row={r}
					href={href}
					look="quiet"
					end={groceries ? tickSlot("1s", "mt-0.5") : undefined}
				/>
			);
		if (option === "let-go")
			return (
				<BudgetRow
					row={r}
					href={href}
					look="quiet"
					li={groceries ? pressTint("1s") : ""}
				/>
			);
		return <ProgressRow {...r} href={href} />;
	};
	return (
		<Still
			label={`${optionName(option)}, Home at 1 second`}
			size="home"
			tab="home"
			toast={<Toast>{SAVED_BUDGET_TOAST}</Toast>}
		>
			<div class="mt-3">
				<Band
					href="/transactions/organize"
					detail="$211 of this month's spending"
				>
					10<span class="sr-only"> transactions</span> need a category
				</Band>
			</div>
			<BudgetBlock>
				{BUDGET.map((r, i) => rows(i === 0 ? GROCERIES_SAVED : r, i))}
			</BudgetBlock>
		</Still>
	);
}

const OPTION_NAMES: Record<Option, string> = {
	today: "Today (current)",
	tick: "A · Auditor's tick",
	"let-go": "B · Let go",
};
const optionName = (option: Option) => OPTION_NAMES[option];
const MOMENT_WORDS: Record<Moment, string> = {
	"0s": "0 seconds",
	"1s": "1 second",
	end: "4 seconds, the toast gone",
	replay: "replaying every 5 seconds",
	keyboard: "1 second, keyboard focus",
};
const momentWords = (moment: Moment) => MOMENT_WORDS[moment];

/** Under each option (Today excepted): how the keyboard, a filtered list and the desktop behave. */
const FILTERED_LINE =
	"If the row leaves a filtered list: the toast only; focus goes to the result count.";
const DESKTOP_LINE = "Desktop: the same, beside the open edit panel.";

/** One option of P119: its words, then its stills in a row and the Home still. */
function SavedOption({
	option,
	note,
	cost,
	why,
	recommended,
	picked,
	notes = [],
	pictures,
}: {
	option: Option;
	note: string;
	cost?: string;
	why?: string;
	recommended?: boolean;
	picked?: boolean;
	notes?: string[];
	pictures: { caption: string; still: Child }[];
}) {
	return (
		<div class="flex w-full flex-col gap-3">
			<div class="flex flex-col gap-1">
				<h4 class="flex flex-wrap items-center gap-x-2 font-semibold">
					{optionName(option)}
					{recommended && (
						<span class="rounded-full border border-ink px-2.5 py-0.5 text-sm font-medium">
							Recommended
						</span>
					)}
					{picked && <PickedPill />}
				</h4>
				<p class="text-sm">{note}</p>
				{cost && <p class="text-sm text-muted">Trade-off: {cost}</p>}
				{why && <p class="text-sm text-muted">Why: {why}</p>}
				{notes.map((line) => (
					<p class="text-sm text-muted">{line}</p>
				))}
			</div>
			<div class="overflow-x-auto">
				<div data-screen="picture">
					<div class="flex flex-wrap gap-x-6 gap-y-6">
						{pictures.map((p) => (
							<div class="flex flex-col gap-2">
								<p class="text-sm text-muted">{p.caption}</p>
								{p.still}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

/** The four moments of one option: its stills, its replay or keyboard ring, and the Home still. */
function savedPictures(option: Option) {
	const fourth: Moment = option === "today" ? "keyboard" : "replay";
	return [
		{ caption: "At 0 seconds", still: savedCrop(option, "0s") },
		{ caption: "At 1 second", still: savedCrop(option, "1s") },
		{
			caption: "At 4 seconds, the toast gone",
			still: savedCrop(option, "end"),
		},
		{
			caption:
				fourth === "keyboard"
					? "Keyboard, 1 second"
					: "Replay, every 5 seconds",
			still: savedCrop(option, fourth),
		},
		{ caption: "Home, 1 second", still: savedHome(option) },
	];
}

// ---------------------------------------------------------------------------------------------

/** P118 and P119 on the proposals page, picked (decision 111): each option drawn, the owner's pick marked. */
export function PolishRoundAProposals() {
	return (
		<>
			<Specimen
				id="p118-rows"
				title="P118 · How a row shows it opens"
				tier="visual"
				sentence="Rows that open don't show it on touch, and Needs category is a filled pill on up to half the rows. Pick how a row shows it opens. In both options, the filled pill becomes quiet words beside the bank text. Each is Transactions above Home's budget list on a phone, at 390."
			>
				<Fixed>
					rows open their sheet (decisions 38, 80); status is never colour or
					shape alone; 44px targets; the Band keeps the screen's one ink arrow;
					Select mode ticks with a round mark at the left (P81).
				</Fixed>
				<Choices
					choices={[
						{
							name: "Today (current)",
							note: "The real rows, as the app draws them now: each row that opens ends in the arrow, and Needs category is quiet words.",
							picture: todayPicture,
						},
						{
							name: "A · Quiet chevron",
							recommended: true,
							picked: true,
							note: "Every row that opens ends in the same small muted arrow Settings already uses.",
							cost: "One small arrow on four kinds of row; names lose about 2 letters at 390.",
							why: "A tap target you can see on every row, and twelve pills become quiet words.",
							picture: quietPicture,
						},
						{
							name: "B · Say it once",
							note: "Rows stay as calm as today; one plain sentence tells a new person what a tap does.",
							cost: "After two weeks a resting row shows nothing again.",
							why: "Nothing added to any row.",
							picture: sayPicture,
						},
						{
							name: "Desktop · Today (current)",
							note: "Transactions at 1280: the six rows as they are.",
							desktop: true,
							picture: <ul class="divide-y divide-rule">{todayRows(SIX)}</ul>,
						},
						{
							name: "Desktop · A · Quiet chevron",
							note: "Transactions at 1280: the same six rows, with the arrow.",
							picked: true,
							desktop: true,
							picture: <ul class="divide-y divide-rule">{quietRows()}</ul>,
						},
					]}
				/>
				<p class="mt-10 text-lg font-semibold">
					Pressed, and Select mode beside it
				</p>
				<div class="mt-4">
					<Crops
						items={[
							{
								name: "Today, pressed",
								note: "Held down, today's row shows nothing: no change while the finger is on it.",
								picture: pressedToday,
							},
							{
								name: "A, pressed",
								note: "The shared press: the row's box in the press tint (--color-press), square, between its rules.",
								picture: pressedQuiet,
							},
							{
								name: "Select mode, Local Bakery ticked",
								note: "The round mark with its tick, which never looks like an arrow to open.",
								picture: pressedSelect,
							},
						]}
					/>
				</div>
			</Specimen>

			<Specimen
				id="p119-saved"
				title="P119 · How the row you just saved shows it changed"
				tier="visual"
				sentence="Saving a row closes its sheet, and the toast says what changed. Pick how the row shows it changed too. Each is Transactions after Local Bakery is saved as Eating Out, and Home after the Groceries budget is saved at $650, on a phone."
			>
				<Fixed>
					the toast says what changed and the announcer says it too (decision
					101); focus returns to the saved row; motion is 150–200 ms and never
					delays anything, under reduced motion shown at once (decision 76);
					Cancel brings focus back too but changed nothing, so it never shows a
					mark; Select mode and Adjust taps never show it.
				</Fixed>
				<div class="flex flex-col gap-10">
					<SavedOption
						option="today"
						note="Nothing on touch: the toast says what changed, and the row shows nothing. A keyboard user sees the focus ring on the saved row."
						pictures={savedPictures("today")}
					/>
					<SavedOption
						option="tick"
						recommended
						picked
						note="A pencil tick lands where the row's arrow sits, the mark you'd make in a paper ledger, and lifts with the toast at four seconds."
						cost="One new drawn mark; the row's arrow is hidden while the toast is up."
						why="You see exactly which row you changed, beside its number, and nothing stays behind."
						notes={[
							"Motion, not illustration: a 150 ms confirmation, so the tally mark still appears once per screen.",
							"The toast and the announcer carry the words, so the mark is never the only sign.",
							"It sits where P118 A's arrow is, so it pairs with it.",
							"Keyboard: the focus ring as today, plus the tick.",
							FILTERED_LINE,
							DESKTOP_LINE,
						]}
						pictures={savedPictures("tick")}
					/>
					<SavedOption
						option="let-go"
						note="The row stays pressed for a moment after the sheet closes, then fades."
						cost="A new 1.3-second hold."
						why="Closest to the first idea: a band tint that fades."
						notes={[
							"Keyboard: the focus ring as today, plus the press.",
							FILTERED_LINE,
							DESKTOP_LINE,
						]}
						pictures={savedPictures("let-go")}
					/>
				</div>
			</Specimen>
		</>
	);
}
