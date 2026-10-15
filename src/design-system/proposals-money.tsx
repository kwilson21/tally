// P129 (#80): the money input, state by state, drawn for the owner's pick (decision 47). Each picture is
// Home's budget sheet over Home on a phone, for Groceries in October: the catalog's sample. Today's is the
// real BudgetSheet and MoneyInput. A and B are proposal-only copies of their markup with the change each
// option makes, since nothing in src/views changes for a drawing. Nothing here is built until the owner picks.

import type { Child } from "hono/jsx";
import { parseBudgetAmount } from "../budgets/amount";
import { formatCents, toCents } from "../money";
import { BudgetSheet } from "../views/budget-sheet";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Icon } from "../views/icons";
import { moneyChip } from "../views/money-input";
import { TransactionsButton } from "../views/transactions-button";
import { Fixed, Sheet } from "./proposal-parts";
import { budgetBehind } from "./proposals-phase5-home";
import { Choice, Choices, Shot } from "./proposals-polish-4";
import { PhoneFrame, Specimen, State } from "./specimen";

// Groceries in October, as the catalog's budget sheet draws it (catalog.tsx's groceriesSheet).
const GROCERIES = {
	id: 1,
	name: "Groceries",
	icon: "groceries",
	color: "cat-blue",
	archived: false,
	budgetCents: 60000,
};
const SPENT_CENTS = 41230;
const LAST_MONTH_CENTS = 57180;
const AVERAGE_CENTS = 60245;
const TRANSACTIONS = 12;
const MONTH = "2026-10";
const LABEL = "Budget from October on";

// The money input's classes, as money-input.tsx has them, and the pressed chip's for A and B.
const round =
	"flex size-12 shrink-0 items-center justify-center rounded-full border border-rule bg-paper text-xl font-semibold leading-none text-muted select-none hover:text-ink disabled:opacity-40";
const cent =
	"flex w-11 flex-1 items-center justify-center text-muted hover:bg-band hover:text-ink disabled:opacity-40";
/** A chip whose amount is in the box: its check shows and its words go ink, instead of fading to 50%. */
const pressedChip =
	"group inline-flex min-h-11 items-center gap-1 rounded-full bg-band px-3 text-sm font-medium text-muted tabular-nums hover:text-ink aria-pressed:text-ink";

/** The typed text in cents, as money-input.tsx reads it: "" is 0, and text that isn't a dollar amount is null. */
function centsOf(text: string): number | null {
	if (text.trim() === "") return 0;
	try {
		return toCents(text);
	} catch {
		return null;
	}
}

/** The ▲ and ▼ of the cent arrows. */
const Arrow = ({ up }: { up: boolean }) => (
	<svg
		class="size-3"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		viewBox="0 0 24 24"
		aria-hidden="true"
	>
		<path d={up ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
	</svg>
);

/**
 * The money input with A's changes, and with B's arrangement too (`left`): money-input.tsx's markup, copied
 * because a drawing can't change the real one. The empty box shows a muted 0.00; a chip that matches the box
 * shows a check; with unreadable text all four steps are off; the chips and error are centred (A) or at the
 * left (B), with Round to last in B.
 */
function ProposedMoney({
	id,
	value,
	error,
	left,
}: {
	id: string;
	value: string;
	error?: string;
	left: boolean;
}) {
	const cents = centsOf(value);
	const unreadable = cents === null;
	const atZero = cents === null || cents === 0;
	const roundTo =
		cents !== null && cents % 100 !== 0 ? (
			<button type="button" class={moneyChip}>
				Round to{" "}
				{formatCents(Math.ceil(cents / 100) * 100, { wholeDollars: true })}
			</button>
		) : null;
	return (
		<div class="flex flex-col gap-2">
			<label for={id} class="text-base text-ink">
				{LABEL}
			</label>
			<div class="flex items-center justify-center gap-3">
				<button
					type="button"
					data-nudge="-100"
					aria-label={`Decrease ${LABEL} by $1`}
					disabled={atZero}
					class={round}
				>
					−
				</button>
				<div
					class={`flex min-h-[90px] w-[292px] min-w-0 items-center gap-1 rounded-control border bg-paper py-3 pl-3 ${error ? "border-over" : "border-rule"}`}
				>
					<span
						aria-hidden="true"
						class="shrink-0 text-lg text-muted select-none"
					>
						$
					</span>
					<input
						id={id}
						name="budget"
						value={value}
						placeholder="0.00"
						inputmode="decimal"
						autocomplete="off"
						aria-invalid={error ? "true" : undefined}
						aria-describedby={error ? `${id}-error` : undefined}
						class="-my-3 min-w-0 flex-1 self-stretch bg-transparent text-[1.75rem] font-bold tabular-nums placeholder:font-normal placeholder:text-muted focus-visible:outline-none"
					/>
					<div class="-my-3 flex flex-col self-stretch border-l border-rule">
						<button
							type="button"
							data-nudge="1"
							aria-label={`Increase ${LABEL} by 1 cent`}
							disabled={unreadable}
							class={`${cent} rounded-tr-control`}
						>
							<Arrow up />
						</button>
						<button
							type="button"
							data-nudge="-1"
							aria-label={`Decrease ${LABEL} by 1 cent`}
							disabled={atZero}
							class={`${cent} rounded-br-control border-t border-rule`}
						>
							<Arrow up={false} />
						</button>
					</div>
				</div>
				<button
					type="button"
					data-nudge="100"
					aria-label={`Increase ${LABEL} by $1`}
					disabled={unreadable}
					class={round}
				>
					+
				</button>
			</div>
			{error && (
				<p
					id={`${id}-error`}
					role="alert"
					class={left ? "text-sm text-over" : "text-center text-sm text-over"}
				>
					{error}
				</p>
			)}
			<div
				class={
					left ? "flex flex-wrap gap-2" : "flex flex-wrap justify-center gap-2"
				}
			>
				{!left && roundTo}
				<button
					type="button"
					aria-pressed={String(cents === LAST_MONTH_CENTS)}
					class={pressedChip}
				>
					<span class="hidden group-aria-pressed:inline-flex">
						<Icon name="check" class="size-4" />
					</span>
					Last month: {formatCents(LAST_MONTH_CENTS)}
				</button>
				<button
					type="button"
					aria-pressed={String(cents === AVERAGE_CENTS)}
					class={pressedChip}
				>
					<span class="hidden group-aria-pressed:inline-flex">
						<Icon name="check" class="size-4" />
					</span>
					3-month average: {formatCents(AVERAGE_CENTS)}
				</button>
				{left && roundTo}
			</div>
		</div>
	);
}

/** Today's budget sheet: the real BudgetSheet, over Home's budget list. */
function TodaySheet({
	id,
	value,
	error,
}: {
	id: string;
	value: string;
	error?: string;
}) {
	return (
		<Sheet behind={budgetBehind} top="top-24">
			<BudgetSheet
				id={id}
				category={GROCERIES}
				value={value}
				error={error}
				spentCents={SPENT_CENTS}
				lastMonthCents={LAST_MONTH_CENTS}
				averageCents={AVERAGE_CENTS}
				transactionCount={TRANSACTIONS}
				month={MONTH}
				closeHref="/"
				closeAttrs={{}}
			/>
		</Sheet>
	);
}

/** A's and B's budget sheet: BudgetSheet's own markup, around the proposed money input. */
function ProposedSheet({
	id,
	value,
	error,
	left,
}: {
	id: string;
	value: string;
	error?: string;
	left: boolean;
}) {
	return (
		<Sheet behind={budgetBehind} top="top-24">
			<div class="flex items-center gap-3">
				<CategoryIcon icon={GROCERIES.icon} color={GROCERIES.color} />
				<h2 class="min-w-0 wrap-anywhere font-serif text-4xl font-semibold tracking-tight">
					{GROCERIES.name}
				</h2>
			</div>
			<p class="mt-1 text-muted">
				{formatCents(SPENT_CENTS)} spent so far in October
			</p>
			<TransactionsButton href="/transactions" count={TRANSACTIONS} />
			<div class="mt-4 flex flex-col gap-4 border-t border-rule pt-4">
				<ProposedMoney id={id} value={value} error={error} left={left} />
				<div class="mt-2 grid grid-cols-2 gap-3">
					<Button kind="secondary" type="button" class="w-full">
						Cancel
					</Button>
					<Button type="button" class="w-full">
						Save
					</Button>
				</div>
			</div>
		</Sheet>
	);
}

/** One picture: a phone's screen, labelled with its option and state. */
function Picture({ label, children }: { label: string; children?: Child }) {
	return (
		<PhoneFrame label={`${label}, on a phone`}>
			<div data-screen="picture">{children}</div>
		</PhoneFrame>
	);
}

// The five states, in the order the owner sees them. `id` makes each picture's ids its own.
const refusal = parseBudgetAmount("six hundred");
const STATES = [
	{ id: "empty", label: "Empty", tag: "empty", value: "" },
	{
		id: "cents",
		label: "With cents: Round to $613 appears",
		tag: "with cents",
		value: "612.45",
	},
	{
		id: "last",
		label: "Equal to last month: Round to $572 appears too",
		tag: "equal to last month",
		value: "571.80",
	},
	{
		id: "zero",
		label: "At $0: the minus buttons are off",
		tag: "at $0",
		value: "0.00",
	},
	{
		id: "error",
		label: "Error: “six hundred” isn’t an amount",
		tag: "error",
		value: "six hundred",
		error: refusal.ok ? undefined : refusal.error,
	},
];

/** What the spec and decisions already fix, and the keyboard and screen-reader fixes either option brings. */
const FIXED_LIST = [
	"When − or ▼ reaches $0 while it has focus, focus moves to its pair instead of being dropped.",
	"↑ and ↓ in the field are announced.",
	"Round to stays, ticked, after use instead of vanishing while focused.",
	"Announced amounts use commas: “$1,234.50”.",
	"A typed third decimal is refused, not cut.",
];

export function MoneyInputProposal() {
	return (
		<section aria-labelledby="p129-title" class="mt-10">
			<h2 id="p129-title" class="font-serif text-3xl font-semibold">
				Open: the money input, state by state
			</h2>
			<p class="mt-2 max-w-prose text-muted">
				Drawn Oct 15 for #80: today’s money input beside two ways to put back
				what it lost from the original, in each of its five states.
			</p>
			<Specimen
				id="p129-money"
				title="P129 · The money input, state by state"
				tier="visual"
				sentence="Today's money input beside two ways to put back what it lost from the original, in each of its five states. Each picture is Home's budget sheet for Groceries in October, on a phone."
			>
				<Fixed>
					the round ±$1 buttons either side of the box (decision 46), its 12px
					control corners (decision 85, Q61 A) and the 3-month average chip
					(decision 85, Q62 B).
				</Fixed>
				<Choices>
					<Choice
						name="Reference · Today on main"
						note="The money input as it is on main: the round ±$1 buttons, a box with ▲▼ cent arrows, and the chips under it. Not an option."
					/>
					<Choice
						name="Option A · Today’s, with what it lost put back"
						note="The same box, buttons and chips. The empty box shows a muted 0.00, a chip that matches the box gets a check instead of fading, and the buttons that can’t work with unreadable text turn off."
						cost="money.js changes only (decision 39); no new token or script."
						why="it keeps the owner’s own hero layout, centred, and fixes the losses: the placeholder, a faded chip that reads at about 2.3:1, and buttons that do nothing."
					/>
					<Choice
						name="Option B · One left edge"
						note="Everything in A, and the chips and error line up at the left with the label, with Round to last, so the other chips stay put as cents come and go."
						cost="same as A."
						why="one left edge for the whole sheet, and nothing moves under a finger."
						recommended={false}
					/>
				</Choices>
				{STATES.map((s) => (
					<State label={s.label}>
						<div class="flex flex-wrap gap-6">
							<Shot caption="Today on main">
								<Picture label={`Today on main, ${s.tag}`}>
									<TodaySheet
										id={`p129-today-${s.id}`}
										value={s.value}
										error={s.error}
									/>
								</Picture>
							</Shot>
							<Shot caption="Option A">
								<Picture label={`Option A, ${s.tag}`}>
									<ProposedSheet
										id={`p129-a-${s.id}`}
										value={s.value}
										error={s.error}
										left={false}
									/>
								</Picture>
							</Shot>
							<Shot caption="Option B">
								<Picture label={`Option B, ${s.tag}`}>
									<ProposedSheet
										id={`p129-b-${s.id}`}
										value={s.value}
										error={s.error}
										left
									/>
								</Picture>
							</Shot>
						</div>
					</State>
				))}
				<div class="max-w-prose">
					<p class="text-sm font-medium text-muted">
						Fixed with either option (keyboard and screen-reader paths)
					</p>
					<ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
						{FIXED_LIST.map((item) => (
							<li>{item}</li>
						))}
					</ul>
				</div>
			</Specimen>
		</section>
	);
}
