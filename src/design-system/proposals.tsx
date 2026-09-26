// The proposals page (#79): each undecided proposal from docs/design-system/audit-2026-09-26.md
// next to today's version, so the owner decides by seeing, not reading (DESIGN.md). "Today" uses
// the real components; "Proposed" is a labelled prototype that only lives here. The page is
// removed once every proposal is decided, and an accepted one moves into the real component.
import type { Child } from "hono/jsx";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { barGeometry } from "../views/bar";
import { Wordmark } from "../views/brand";
import { CategoryIcon } from "../views/category";
import { HowLink } from "../views/how-link";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { MoneyInput } from "../views/money-input";
import { ProgressRow } from "../views/progress-row";
import { ThingsToTry } from "../views/things-to-try";
import { TransactionRow } from "../views/transaction-row";
import { Specimen } from "./specimen";

// Home in the demo today (seed data), so both versions of P1 show the same numbers.
const HOME_ROWS = [
	{
		name: "Groceries",
		icon: "groceries",
		color: "cat-blue",
		spentCents: 41200,
		budgetCents: 70000,
	},
	{
		name: "Eating Out",
		icon: "eating-out",
		color: "cat-plum",
		spentCents: 28600,
		budgetCents: 25000,
	},
	{
		name: "Gas",
		icon: "gas",
		color: "cat-slate",
		spentCents: 18600,
		budgetCents: 20000,
	},
	{
		name: "Kids",
		icon: "kids",
		color: "cat-ochre",
		spentCents: 21000,
		budgetCents: 30000,
	},
	{
		name: "Household",
		icon: "household",
		color: "cat-brown",
		spentCents: 9500,
		budgetCents: 25000,
	},
];
const SAFE = formatCents(28300, { wholeDollars: true });
const STATUS = "Eating Out is $36 over. Everything else is on track.";
const NEEDS = "12 transactions need a category";

/** Raw bank text from the demo's seed, and what P2 would show instead. */
export const NAME_PAIRS: [string, string][] = [
	["SQ *LOCAL BAKERY 4432", "Local bakery"],
	["DD *DOORDASH TACO", "Doordash taco"],
	["GOOGLE *YOUTUBE", "Google youtube"],
	["APPLE.COM/BILL", "Apple.com/bill"],
	["CHECKCARD 0921 CVS", "Cvs"],
	["POS 4417 CITY PARKING", "City parking"],
	["TST* CORNER DELI", "Corner deli"],
];

/** Two versions side by side on a wide screen, one above the other on a phone. */
function Compare({
	today,
	proposed,
	otherLabel = "Proposed",
}: {
	today: Child;
	proposed: Child;
	otherLabel?: string;
}) {
	return (
		<div class="grid gap-8 lg:grid-cols-2">
			<div class="flex min-w-0 flex-col gap-3">
				<p class="text-sm font-semibold uppercase tracking-wide text-muted">
					Today
				</p>
				{today}
			</div>
			<div class="flex min-w-0 flex-col gap-3">
				<p class="text-sm font-semibold uppercase tracking-wide text-muted">
					{otherLabel}
				</p>
				{proposed}
			</div>
		</div>
	);
}

/**
 * A phone's first screen: exactly 390 wide inside its 1px border, and 788 tall, which is 844 minus
 * the 56px tab bar. Anything below its edge is what a person has to scroll to see. On a screen
 * narrower than that, it scrolls sideways in its column rather than shrinking, so the text wraps
 * exactly as it does on a real phone.
 */
function PhoneFrame({ label, children }: { label: string; children?: Child }) {
	// A picture of a screen, not a working one: one labelled image, with nothing inside to Tab to.
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={label}
				class="h-[790px] w-[392px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
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
			</div>
		</div>
	);
}

function HomeRows() {
	return (
		<ul class="mt-2 divide-y divide-rule">
			{HOME_ROWS.map((row) => (
				<ProgressRow {...row} />
			))}
			<li class="flex items-center gap-4 py-3 text-muted">
				<Icon name="circle-dashed" class="size-7 shrink-0" />
				<span class="flex-1 text-lg">Uncategorized</span>
				<span class="text-lg">$228</span>
			</li>
		</ul>
	);
}

/** Home's top as src/routes/home.tsx draws it today. */
function HomeToday() {
	return (
		<>
			<div class="mb-6">
				<ThingsToTry />
			</div>
			<p class="font-serif text-5xl font-semibold tracking-tight">September</p>
			<HowLink section="budget" demo />
			<div class="mt-4 flex items-center justify-between gap-6">
				<div>
					<p class="text-lg text-muted">Safe to spend</p>
					<p class="font-serif text-6xl font-semibold tracking-tight">{SAFE}</p>
				</div>
				<LedgerIllustration />
			</div>
			<p class="mt-3 font-serif text-lg italic">{STATUS}</p>
			<div class="mt-6">
				<Band href="/transactions?uncategorized=1">{NEEDS}</Band>
			</div>
			<p class="mt-8 font-serif text-3xl font-semibold">Budget</p>
			<HomeRows />
		</>
	);
}

/** P1: the number first, the month smaller, the demo's aids below the Budget list. */
function HomeProposed() {
	return (
		<>
			<p class="font-serif text-2xl font-semibold tracking-tight">September</p>
			<div class="mt-2 flex items-center justify-between gap-6">
				<div>
					<p class="text-lg text-muted">Safe to spend</p>
					<p class="font-serif text-6xl font-semibold tracking-tight">{SAFE}</p>
				</div>
				<LedgerIllustration />
			</div>
			<p class="mt-3 font-serif text-lg italic">{STATUS}</p>
			<HowLink section="budget" demo />
			<div class="mt-4">
				<Band href="/transactions?uncategorized=1">{NEEDS}</Band>
			</div>
			<p class="mt-8 font-serif text-3xl font-semibold">Budget</p>
			<HomeRows />
			<div class="mt-8">
				<ThingsToTry />
			</div>
		</>
	);
}

const needsRow = (
	id: number,
	rawName: string,
	displayName: string,
): ListRow => ({
	id,
	date: "2026-09-22",
	amountCents: 1200 + id * 137,
	rawName,
	displayName,
	note: null,
	excluded: false,
	income: false,
	categoryId: null,
	categoryName: null,
	categoryIcon: null,
	categoryColor: null,
});

function NameList({ tidy }: { tidy: boolean }) {
	return (
		<ul class="divide-y divide-rule">
			{NAME_PAIRS.map(([raw, tidied], i) => (
				<TransactionRow row={needsRow(i + 1, raw, tidy ? tidied : raw)} />
			))}
		</ul>
	);
}

/** P3's other option: the original catalog's currency input, in Tally's tokens. Static. */
function StackedMoney() {
	return (
		<div class="flex flex-col gap-2">
			<p class="text-base text-ink">Budget</p>
			<div class="flex items-center gap-3">
				<div class="flex min-h-[90px] min-w-0 flex-1 items-center gap-1 rounded-control border border-rule bg-paper pl-3">
					<span aria-hidden="true" class="text-lg text-muted">
						$
					</span>
					<span class="flex-1 text-[1.75rem] font-bold tabular-nums">
						612.40
					</span>
					<span class="flex flex-col self-stretch border-l border-rule text-muted">
						<span class="flex w-11 flex-1 items-center justify-center">
							<Icon name="chevron" class="size-4 -rotate-90" />
						</span>
						<span class="flex w-11 flex-1 items-center justify-center border-t border-rule">
							<Icon name="chevron" class="size-4 rotate-90" />
						</span>
					</span>
				</div>
				<div class="flex w-12 flex-col self-stretch overflow-hidden rounded-control border border-rule text-xl text-muted">
					<span class="flex flex-1 items-center justify-center">+</span>
					<span class="flex flex-1 items-center justify-center border-t border-rule">
						−
					</span>
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				<span class="inline-flex min-h-11 items-center rounded-full bg-band px-3 text-sm font-medium text-muted">
					Round to $613
				</span>
				<span class="inline-flex min-h-11 items-center rounded-full bg-band px-3 text-sm font-medium text-muted">
					Last month: $600.00
				</span>
			</div>
		</div>
	);
}

/** P4: ProgressRow with a 4px bar instead of 8px; everything else as today. */
function ThinRow({
	name,
	icon,
	color,
	spentCents,
	budgetCents,
}: (typeof HOME_ROWS)[number]) {
	const over = spentCents > budgetCents;
	const { fillPct, limitPct } = barGeometry(spentCents, budgetCents);
	const whole = (c: number) => formatCents(c, { wholeDollars: true });
	return (
		<li class="flex items-start gap-4 py-3">
			<CategoryIcon icon={icon} color={color} />
			<div class="min-w-0 flex-1">
				<div class="flex items-baseline justify-between gap-3">
					<span class="text-lg">{name}</span>
					<span class="text-lg">
						{whole(spentCents)} of {whole(budgetCents)}
					</span>
				</div>
				<svg class="mt-2 h-1 w-full" aria-hidden="true">
					<rect width="100%" height="100%" rx="2" class="fill-rule" />
					<rect
						width={`${fillPct}%`}
						height="100%"
						rx="2"
						class={over ? "fill-over" : "fill-ok"}
					/>
					<line
						x1={`${limitPct}%`}
						x2={`${limitPct}%`}
						y1="0"
						y2="100%"
						class="stroke-ink"
						stroke-width="1.75"
					/>
				</svg>
				{over && (
					<p class="mt-1 flex items-center justify-end gap-1 text-over">
						<Icon name="alert" class="size-5" />
						over budget
					</p>
				)}
			</div>
		</li>
	);
}

/** The proposals page body. */
export function Proposals() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Proposals
			</h1>
			<p class="mt-3 max-w-prose text-lg">
				Each proposal from the design audit, next to how Tally looks today.
				Nothing here is decided. For each one, say which you want: keep today's,
				take the proposal, or change it. Look at it on your phone as well as a
				wide screen.
			</p>
			<p class="mt-2">
				<a href="/design-system" class="inline-flex min-h-11 items-center">
					Back to the design system
				</a>
			</p>

			<Specimen
				id="p1"
				title="P1 · The number on a phone's first screen"
				tier="visual"
				sentence="Each frame is a phone's first screen, cut off where the tab bar starts. Proposed: the month smaller, safe to spend first, and the demo's Things to try moved below the Budget list."
			>
				<Compare
					today={
						<PhoneFrame label="Home's first screen on a phone today: Things to try, the month, then safe to spend $283 halfway down.">
							<HomeToday />
						</PhoneFrame>
					}
					proposed={
						<PhoneFrame label="Home's first screen as proposed: safe to spend $283 at the top, then the status, the band and the budget list.">
							<HomeProposed />
						</PhoneFrame>
					}
				/>
			</Specimen>

			<Specimen
				id="p2"
				title="P2 · Tidied bank names"
				tier="visual"
				sentence="Transactions nobody has named yet. Proposed: code removes card prefixes and uses sentence case. The row still shows the raw text underneath, and a name you choose always wins. Note the cost: acronyms lose their capitals (“Cvs”)."
			>
				<Compare
					today={<NameList tidy={false} />}
					proposed={<NameList tidy />}
				/>
			</Specimen>

			<Specimen
				id="p3"
				title="P3 · The money input's ±$1 buttons"
				tier="visual"
				sentence="Your first answer was the round buttons, which is today's. The other option is the original catalog's: +$1 and −$1 stacked in a box beside the field."
			>
				<Compare
					today={
						// Inert, like the other option: a picture to compare, so neither changes while
						// you look. The working one is in the catalog's MoneyInput entry.
						<div inert>
							<MoneyInput
								id="p3-today"
								name="p3-today"
								label="Budget"
								value="612.40"
								lastMonthCents={60000}
							/>
						</div>
					}
					proposed={<StackedMoney />}
					otherLabel="The other option"
				/>
			</Specimen>

			<Specimen
				id="p4"
				title="P4 · Thinner budget bars"
				tier="visual"
				sentence="Proposed: the bar is 4px instead of 8px, in the same colors, so the names and amounts lead. Over budget keeps its icon and words."
			>
				<Compare
					today={
						<ul class="divide-y divide-rule">
							{HOME_ROWS.map((row) => (
								<ProgressRow {...row} />
							))}
						</ul>
					}
					proposed={
						<ul class="divide-y divide-rule">
							{HOME_ROWS.map((row) => (
								<ThinRow {...row} />
							))}
						</ul>
					}
				/>
			</Specimen>
		</>
	);
}
