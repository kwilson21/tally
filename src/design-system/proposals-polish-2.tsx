// P118 and P119 (#497 and #71, decision 47): the polish track's open choices, drawn so the owner can
// pick by seeing. P118 is how a row shows it opens, and how loud Needs category is. P119 is how the
// row you just saved shows it changed. Today's pictures are the real components. Each option is a
// copy of them that changes only what the option changes, so the pictures compare like with like.
// Nothing here is decided until the owner picks.

import type { Child } from "hono/jsx";
import { dayLabel } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { AdjustLink } from "../views/adjust-link";
import { Band } from "../views/band";
import { barGeometry } from "../views/bar";
import { CategoryIcon } from "../views/category";
import { Icon } from "../views/icons";
import { ProgressRow } from "../views/progress-row";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { rowCaption, TransactionRow } from "../views/transaction-row";
import { DesktopFrame, Fixed } from "./proposal-parts";
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
const WATER = tx(2004, TODAY, "Google youtube", 1399, HOUSEHOLD, {
	paysBill: true,
	billName: "Water bill",
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

/** Needs category as words, in P118's three looks; the pill is today's (TransactionRow). */
type Look = "quiet" | "ledger" | "say";
const WORDS: Record<Look, [string, string]> = {
	quiet: ["text-muted", "text-muted"],
	ledger: ["font-serif italic text-muted", "font-serif italic text-muted"],
	say: ["text-ink", "text-muted"],
};

/** The arrow every row that opens ends in (P118 A): hung into the margin so its tip is the content's edge. */
const ARROW = "size-5 shrink-0 -ml-3 -mr-2 text-muted";

/**
 * A transaction row as TransactionRow draws it, copied with what the option changes: an arrow after
 * the amount (quiet), an arrow at the end of the caption's line under a ledger line (ledger), or no
 * arrow (say). `press` holds the row's box in the press tint. `end` takes the arrow's place (P119's
 * tick); `li` and `after` are the saved row's own classes and its rule.
 */
function TxRow({
	row,
	look,
	press = false,
	end,
	li = "",
	after,
}: {
	row: ListRow;
	look: Look;
	press?: boolean;
	end?: Child;
	li?: string;
	after?: Child;
}) {
	const { kind, caption, tag } = rowCaption(row);
	const [words, bank] = WORDS[look];
	const amount = formatCents(row.amountCents, { signed: true });
	const said =
		tag && kind === "needs" ? (
			<>
				<span class={`shrink-0 ${words}`}>Needs category</span>
				{caption && (
					<span class={`min-w-0 truncate ${bank}`}>{` · ${caption}`}</span>
				)}
			</>
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
				{look === "ledger" ? (
					<span class="min-w-0 flex-1">
						<span class="flex items-baseline gap-3">
							<span class="block min-w-0 flex-1 truncate text-lg leading-6">
								{row.displayName}
							</span>
							<span class="shrink-0 text-lg leading-6">{amount}</span>
						</span>
						<span class="flex min-w-0 items-center gap-2 leading-6">
							{said}
							<Icon
								name="chevron-right"
								class="ml-auto -mr-2 shrink-0 text-muted size-5"
							/>
						</span>
					</span>
				) : (
					<>
						<span class="min-w-0 flex-1">
							<span class="block truncate text-lg leading-6">
								{row.displayName}
							</span>
							<span class="flex min-w-0 items-center gap-2 leading-6">
								{said}
							</span>
						</span>
						<span class="shrink-0 text-lg">{amount}</span>
						{look === "quiet" &&
							(end ?? <Icon name="chevron-right" class={ARROW} />)}
					</>
				)}
			</a>
			{after}
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
 * A budget row as ProgressRow draws it, copied with what the option changes: the arrow centred on the
 * row, outside its text (quiet), or the arrow at the end of the bar's line (ledger). `end` takes the
 * arrow's place (P119 A's tick), `after` sits under the row (P119 B's rule), and `li` is the row's own
 * class (P119 C's band).
 */
function BudgetRow({
	row,
	href,
	look,
	end,
	after,
	li = "",
}: {
	row: Budget;
	href: string;
	look: Look;
	end?: Child;
	after?: Child;
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
					{look === "ledger" ? (
						<div class="mt-2 flex items-center gap-3">
							<Bar row={row} class="h-1 min-w-0 flex-1" />
							<Icon
								name="chevron-right"
								class="size-5 shrink-0 -mr-2 text-muted"
							/>
						</div>
					) : (
						<Bar row={row} class="mt-2 h-1 w-full" />
					)}
					{over && (
						<p class="mt-1 flex items-center justify-end gap-1 text-over">
							<Icon name="alert" class="size-5" />
							{formatCents(overBy, { wholeDollars: overBy % 100 === 0 })} over
							<span class="sr-only"> budget</span>
						</p>
					)}
				</div>
				{look === "quiet" &&
					(end ?? <Icon name="chevron-right" class={`self-center ${ARROW}`} />)}
			</a>
			{after}
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

/** P118's rows as the real components draw them today: the pill, no arrow, nothing pressed. */
const todayRows = (rows: ListRow[]) =>
	rows.map((r) => <TransactionRow row={r} href={transactionHref(r.id)} />);

/** P118's budget rows as the real ProgressRow draws them today. */
const todayBudget = () =>
	BUDGET.map((r, i) => <ProgressRow {...r} href={budgetHref(i)} />);

/** P118's quiet or ledger copies of the six rows, Local Bakery held down (the press is shared). */
const pressedRows = (look: Look) =>
	SIX.map((r) => <TxRow row={r} look={look} press={r.id === BAKERY.id} />);

// ---------------------------------------------------------------------------------------------
// Stills: one 390 crop each, a phone's crop with its tab bar's line drawn at the bottom. The toast
// sits 12px above that line, where #toasts puts it. A still is a picture: labelled, inert, nothing to tap.

const SIZE = {
	short: "h-[216px]",
	crop: "h-[380px]",
	home: "h-[400px]",
} as const;

/** The 390 still, its crop and its toast. `loop` gives its replay the five-second loop (P119). */
function Still({
	label,
	size = "crop",
	loop = false,
	toast,
	children,
}: {
	label: string;
	size?: keyof typeof SIZE;
	loop?: boolean;
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
			<div class="absolute inset-x-0 bottom-0 h-[57px] border-t border-rule bg-paper" />
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
 * The pencil tick (P119 A): one path in ink, drawn where the arrow sits, rotated −6°. `drawn` is its
 * share of the stroke at a still (0.5 at 70 ms, 1 once drawn). `replay` leaves the share to the loop.
 */
function Tick({
	drawn = 1,
	replay = false,
	class: cls = "",
}: {
	drawn?: number;
	replay?: boolean;
	class?: string;
}) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
			class={`size-5 shrink-0 -rotate-6 text-ink ${cls}`}
		>
			<path
				pathLength="1"
				d="M4.5 12.8c1.7 1.1 3.2 2.7 4.4 4.7 2.6-5 6.4-9.3 10.6-12.3"
				stroke-dasharray={replay ? undefined : "1"}
				stroke-dashoffset={replay ? undefined : 1 - drawn}
				class={replay ? "proposal-saved-tick opacity-0" : undefined}
			/>
		</svg>
	);
}

/** The ruled line under the saved row (P119 B): full width, square, 2px, drawn from the left. */
function Rule({ class: cls }: { class: string }) {
	return (
		<span
			aria-hidden="true"
			class={`absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ink ${cls}`}
		/>
	);
}

// ---------------------------------------------------------------------------------------------
// P118 · How a row shows it opens, and how loud Needs category is.

type Choice = {
	name: string;
	note: string;
	cost?: string;
	why?: string;
	recommended?: boolean;
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

/** The Transactions crop above the Budget crop, one option's phone. */
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

const TAP_TX = "Tap a transaction to change it.";
const TAP_BUDGET = "Tap a budget to change it.";

const todayPicture = (
	<PhoneCrops rows={todayRows(SIX)} budget={todayBudget()} />
);

const quietPicture = (
	<PhoneCrops
		rows={pressedRows("quiet")}
		budget={BUDGET.map((r, i) => (
			<BudgetRow row={r} href={budgetHref(i)} look="quiet" />
		))}
	/>
);

const ledgerPicture = (
	<PhoneCrops
		rows={pressedRows("ledger")}
		budget={BUDGET.map((r, i) => (
			<BudgetRow row={r} href={budgetHref(i)} look="ledger" />
		))}
	/>
);

const sayPicture = (
	<PhoneCrops
		hint={<p class="text-sm text-muted">{TAP_TX}</p>}
		rows={SIX.map((r) => (
			<TxRow row={r} look="say" press={r.id === BAKERY.id} />
		))}
		budgetHint={<p class="mt-1 text-sm text-muted">{TAP_BUDGET}</p>}
		budget={BUDGET.map((r, i) =>
			r === GROCERIES_ROW ? (
				<BudgetRow row={r} href={budgetHref(i)} look="say" />
			) : (
				<ProgressRow {...r} href={budgetHref(i)} />
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

type Option = "today" | "tick" | "rule" | "let-go";
type Moment = "0s" | "1s" | "end" | "replay" | "keyboard";

const SAVED_TOAST = "Saved Local Bakery";
const SAVED_BUDGET_TOAST = "Saved the Groceries budget";

/** The toast at each moment: 70 ms in, a second in, gone at 4 s, and its replay. */
function savedToast(moment: Moment, text: string) {
	if (moment === "end") return undefined;
	if (moment === "0s")
		return <Toast class="translate-y-[2px] opacity-75">{text}</Toast>;
	if (moment === "replay")
		return <Toast class="proposal-saved-toast opacity-0">{text}</Toast>;
	return <Toast>{text}</Toast>;
}

/** The arrow's place when a tick takes it: drawn half way at 0 s, whole at 1 s, the arrow at the end. */
function tickSlot(moment: Moment, centred = false) {
	const margins = centred ? "-ml-3 -mr-2 self-center" : "-ml-3 -mr-2";
	if (moment === "end") return undefined;
	if (moment === "0s") return <Tick drawn={0.5} class={margins} />;
	if (moment === "1s") return <Tick drawn={1} class={margins} />;
	// The replay stacks the arrow and the tick in one box the arrow's size, so they fade across each other.
	return (
		<span class={`relative ${margins} size-5 shrink-0`}>
			<Icon
				name="chevron-right"
				class="proposal-saved-chevron absolute inset-0 size-5 text-muted"
			/>
			<Tick replay class="absolute inset-0" />
		</span>
	);
}

/** The ruled line under the saved row at each moment (P119 B). */
function ruleSlot(moment: Moment) {
	if (moment === "end") return undefined;
	if (moment === "0s") return <Rule class="scale-x-50" />;
	if (moment === "1s") return <Rule class="scale-x-100" />;
	return <Rule class="proposal-saved-rule opacity-0" />;
}

/** The saved row as one option draws it at one moment. */
function savedRow(option: Option, moment: Moment) {
	const href = transactionHref(BAKERY_SAVED.id);
	if (option === "tick" || option === "rule")
		return (
			<TxRow
				row={BAKERY_SAVED}
				look="quiet"
				end={option === "tick" ? tickSlot(moment) : undefined}
				after={option === "rule" ? ruleSlot(moment) : undefined}
			/>
		);
	if (option === "let-go") {
		const band =
			moment === "replay"
				? "proposal-saved-band"
				: moment === "end"
					? ""
					: "bg-band";
		return (
			<li class={band}>
				<TransactionRow row={BAKERY_SAVED} href={href} bare />
			</li>
		);
	}
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
	const quiet = option === "tick" || option === "rule";
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
		if (option === "tick" || option === "rule")
			return (
				<BudgetRow
					row={r}
					href={href}
					look="quiet"
					end={
						groceries && option === "tick" ? tickSlot("1s", true) : undefined
					}
					after={groceries && option === "rule" ? ruleSlot("1s") : undefined}
				/>
			);
		if (option === "let-go" && groceries)
			return <BudgetRow row={r} href={href} look="say" li="bg-band" />;
		return <ProgressRow {...r} href={href} />;
	};
	return (
		<Still
			label={`${optionName(option)}, Home at 1 second`}
			size="home"
			toast={<Toast>{SAVED_BUDGET_TOAST}</Toast>}
		>
			<div class="mt-3">
				<Band
					href="/transactions/organize"
					detail="$228 of this month's spending"
				>
					12 transactions need a category
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
	rule: "B · Ruled off",
	"let-go": "C · Let go",
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

/** One option of P119: its words, then its stills in a row and the Home still. */
function SavedOption({
	option,
	note,
	cost,
	why,
	recommended,
	pictures,
}: {
	option: Option;
	note: string;
	cost?: string;
	why?: string;
	recommended?: boolean;
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
				</h4>
				<p class="text-sm">{note}</p>
				{cost && <p class="text-sm text-muted">Trade-off: {cost}</p>}
				{why && <p class="text-sm text-muted">Why: {why}</p>}
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

/** P118 and P119 on the proposals page, open: each option drawn, none picked. */
export function PolishRoundAProposals() {
	return (
		<>
			<Specimen
				id="p118-rows"
				title="P118 · How a row shows it opens, and how loud Needs category is"
				tier="visual"
				sentence="Rows that open don't show it on touch, and Needs category is a filled pill on up to half the rows. Pick how a row shows it opens, and how loud Needs category is. Each is Transactions above Home's budget list on a phone, at 390."
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
							note: "The real rows, as they are: no arrow, and Needs category as today's filled pill. Nothing shows on touch.",
							picture: todayPicture,
						},
						{
							name: "A · Quiet chevron",
							recommended: true,
							note: "Every row that opens ends in the same small muted arrow Settings already uses.",
							cost: "One small arrow on four kinds of row; names lose about 2 letters at 390.",
							why: "A tap target you can see on every row, and twelve pills become quiet words.",
							picture: quietPicture,
						},
						{
							name: "B · Ledger line",
							note: "Each row reads like a ledger line, amount beside the name, and points on from its corner.",
							cost: "Moves the amount on every transaction and bill row.",
							why: "Long names and bank text get the most room.",
							picture: ledgerPicture,
						},
						{
							name: "C · Say it once",
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
							note: "Transactions at 1280: the same six rows, with the arrow and the press.",
							desktop: true,
							picture: (
								<ul class="divide-y divide-rule">{pressedRows("quiet")}</ul>
							),
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
								note: "The shared press: the row's box in the press tint (--color-press, proposed), square, between its rules.",
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
						note="A pencil tick lands where the row's arrow sits, the mark you'd make in a paper ledger, and lifts after a second and a half."
						cost="One new drawn icon and one 1.5-second timing."
						why="You see exactly which row you changed, beside its number, and nothing stays behind."
						pictures={savedPictures("tick")}
					/>
					<SavedOption
						option="rule"
						note="The row you saved is ruled off in ink for as long as the toast says what changed."
						cost="No new timing; it follows the toast."
						why="A glance down the list finds the row while the toast is up."
						pictures={savedPictures("rule")}
					/>
					<SavedOption
						option="let-go"
						note="The row stays pressed when the sheet closes, then lets go, as an iPhone list does."
						cost="A new 1.3-second hold; for that moment Home has two tinted rows (the Band and this one)."
						why="Closest to the first idea: a band tint that fades."
						pictures={savedPictures("let-go")}
					/>
				</div>
			</Specimen>
		</>
	);
}
