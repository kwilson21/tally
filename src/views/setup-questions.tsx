// The setup question screens (P142 A, decision 148, spec §8.8, #773): once the questions are open, each question is one screen:
// the step bar, the question as the serif heading, the bank's own numbers as a ruled card or list, and the answers at the foot.
// The words are the picked drawing's (proposals-setup.tsx's PayBody, BudgetsBody) and the old question page's, which setup
// replaced (#773), and each form carries the fields the answer reads (routes/first-page.tsx). A form swaps the whole screen
// (#setup-screen).
import type { Child } from "hono/jsx";
import type { BillSuggestion } from "../bills/find";
import { monthName, ordinal, shortMonthName } from "../dates";
import {
	billsLead,
	billsTotalLine,
	keepHeading,
	shownBillValue,
	waitingWords,
} from "../first-tally/bills";
import {
	askHeading,
	type BudgetAsk,
	bankLine,
	budgetsTotalLine,
	keepAllButton,
	keepAllLead,
	keepAllQuestion,
	needsTail,
	shownBudgetValue,
	suggestionNote,
	yesLabel,
} from "../first-tally/budgets";
import type { PayMerchant } from "../first-tally/first-page";
import {
	amountWords,
	depositDay,
	dollarsWords,
	latestDeposits,
	payCadenceLine,
	payLead,
	shownPayValues,
} from "../first-tally/pay";
import type { SkippedNote } from "../first-tally/skipped";
import { centsToAmount, formatCents } from "../money";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { FoldedRow } from "./folded-row";
import { HomeSeenCheckIn } from "./home-seen";
import { MoneyInput } from "./money-input";
import { SetupScreen } from "./setup-screen";
import { BILLS_STEP, BUDGETS_STEP, PAY_STEP, StepBar } from "./step-bar";

/** The question's needs-a-category line: the count and the mean, or none. */
type Needs = { count: number; meanCents: number | null } | null;

/**
 * A question's serif heading. It takes focus when `focus` is given, as setup-welcome's does, so the screen is read once when it
 * is drawn by a form's swap. Its top margin is mt-6 under a question's step bar; the finish's top row takes mt-4 (setup-finish.tsx).
 */
export function Heading({
	focus,
	wrap = false,
	top = "mt-6",
	children,
}: {
	focus: boolean;
	/** The words hold a long name (a category, a bank): they wrap rather than run past the screen. */
	wrap?: boolean;
	/** The heading's top margin class. */
	top?: string;
	children?: Child;
}) {
	return (
		<h1
			class={
				wrap
					? `${top} font-serif text-4xl font-semibold tracking-tight wrap-anywhere`
					: `${top} font-serif text-4xl font-semibold tracking-tight`
			}
			{...(focus ? { tabindex: -1, autofocus: true } : {})}
		>
			{children}
		</h1>
	);
}

/**
 * The steps that asked nothing, under the step bar (P142 A): each names its step in ink, says why in today's words, and, when
 * charges wait in Possible bills, says how many and links to it (Waiting's words). Nothing is drawn with no notes.
 */
export function SkippedSteps({ notes }: { notes: SkippedNote[] }) {
	if (notes.length === 0) return null;
	return (
		<ul class="mt-4 space-y-1 text-sm text-muted">
			{notes.map((note) => {
				const waiting = waitingWords(note.waiting);
				return (
					<li>
						<span class="text-ink">{note.step}</span> · {note.text}
						{waiting && (
							<>
								{" "}
								{waiting}{" "}
								<a href="/bills/find" class="text-accent">
									Possible bills
								</a>
								.
							</>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Pay (P142 A): "Is this your pay?", the lead, the card with the merchant's bank text and its amount, how often it came and the
 * last three deposits with "And N earlier", then "Yes counts it as income, never as spending." The answers at the foot post the
 * merchant and every deposit the page showed, so an answer covers only those (the POST checks them again).
 */
export function SetupPay({
	merchant,
	focus,
	watching = false,
	idSuffix = "",
}: {
	merchant: PayMerchant;
	focus: boolean;
	watching?: boolean;
	idSuffix?: string;
}) {
	const { shown, earlier } = latestDeposits(merchant.deposits);
	const latest = shown[0]?.date ?? "";
	return (
		<SetupScreen
			foot={
				<form
					id={`pay${idSuffix}`}
					method="post"
					action="/setup/pay"
					hx-post="/setup/pay"
					hx-target="#setup-screen"
					hx-swap="outerHTML"
				>
					<input type="hidden" name="merchant" value={merchant.key} />
					{shownPayValues(merchant).map((value) => (
						<input type="hidden" name="deposit" value={value} />
					))}
					<Button type="submit" name="answer" value="yes" class="w-full">
						Yes, that's my pay
					</Button>
					<div class="mt-1 flex justify-center">
						<Button kind="text" type="submit" name="answer" value="no">
							No, it's something else
						</Button>
					</div>
				</form>
			}
		>
			<StepBar done={1} label={PAY_STEP} />
			<Heading focus={focus}>Is this your pay?</Heading>
			<p class="mt-3 text-lg text-muted">
				{payLead(merchant.deposits.map((deposit) => deposit.date))}
			</p>
			<div class="mt-6 rounded-control border border-rule">
				<div class="px-4 py-3">
					{/* The amount may wrap: a range wraps at "to", so the name keeps room for whole words beside it. */}
					<div class="flex items-baseline justify-between gap-3">
						<p class="min-w-0 wrap-break-word font-medium">{merchant.key}</p>
						<p class="font-serif text-2xl font-semibold tabular-nums">
							{amountWords(merchant.deposits)}
						</p>
					</div>
					<p class="text-sm text-muted">{payCadenceLine(merchant.deposits)}</p>
				</div>
				<ul class="divide-y divide-rule border-t border-rule text-sm">
					{shown.map((deposit) => (
						<li class="flex justify-between px-4 py-2">
							<span>{depositDay(deposit.date, latest)}</span>
							<span class="tabular-nums">{formatCents(deposit.cents)}</span>
						</li>
					))}
					{earlier > 0 && (
						<li class="px-4 py-2 text-muted">And {earlier} earlier</li>
					)}
				</ul>
			</div>
			<p class="mt-4 text-sm text-muted">
				Yes counts it as income, never as spending.
			</p>
			{watching && <HomeSeenCheckIn />}
		</SetupScreen>
	);
}

/** One found charge's row: its name, "around the 5th" (Possible bills' words), and its amount. */
function BillRow({ charge }: { charge: BillSuggestion }) {
	return (
		<li class="flex items-center gap-3 border-b border-rule py-2">
			<div class="min-w-0 flex-1 wrap-anywhere">
				<p>{charge.displayName}</p>
				<p class="text-sm text-muted">around the {ordinal(charge.dueDay)}</p>
			</div>
			<p class="shrink-0 tabular-nums">{dollarsWords(charge.amountCents)}</p>
		</li>
	);
}

/**
 * Bills (P142 A): "Keep these 8 as bills?" over the first five charges, the rest folded, the double-ruled total, and what waits
 * in Possible bills. Keep posts the charges the page showed, and Choose which goes to Possible bills. Drawn only with charges to
 * keep: a step with none says so on the next screen (SkippedSteps).
 */
export function SetupBills({
	keep,
	waiting,
	focus,
	watching = false,
	skipped = [],
	idSuffix = "",
}: {
	keep: BillSuggestion[];
	waiting: BillSuggestion[];
	focus: boolean;
	watching?: boolean;
	skipped?: SkippedNote[];
	idSuffix?: string;
}) {
	const shown = keep.slice(0, 5);
	const rest = keep.slice(5);
	const restCents = rest.reduce((sum, charge) => sum + charge.amountCents, 0);
	const total = billsTotalLine(
		keep.length,
		keep.reduce((sum, charge) => sum + charge.amountCents, 0),
	);
	return (
		<SetupScreen
			foot={
				<>
					<form
						id={`bills${idSuffix}`}
						method="post"
						action="/setup/bills"
						hx-post="/setup/bills"
						hx-target="#setup-screen"
						hx-swap="outerHTML"
					>
						{keep.map((charge) => (
							<input type="hidden" name="keep" value={shownBillValue(charge)} />
						))}
						<Button type="submit" class="w-full">
							{keep.length === 1
								? "Keep this one"
								: `Keep these ${keep.length}`}
						</Button>
					</form>
					<div class="mt-1 flex justify-center">
						<Button kind="text" href="/bills/find">
							Choose which
						</Button>
					</div>
				</>
			}
		>
			<StepBar done={2} label={BILLS_STEP} />
			<SkippedSteps notes={skipped} />
			<Heading focus={focus}>{keepHeading(keep.length)}</Heading>
			<p class="mt-3 text-lg text-muted">{billsLead(keep.length)}</p>
			<ul class="mt-6 border-t border-rule">
				{shown.map((charge) => (
					<BillRow charge={charge} />
				))}
			</ul>
			{rest.length > 0 && (
				<FoldedRow
					label={`${rest.length} more · ${dollarsWords(restCents)} a month`}
				>
					<ul>
						{rest.map((charge) => (
							<BillRow charge={charge} />
						))}
					</ul>
				</FoldedRow>
			)}
			<div class="mt-2 flex justify-between border-t-[3px] border-double border-ink pt-2 font-medium">
				<span>{total.label}</span>
				<span class="tabular-nums">{total.amount}</span>
			</div>
			<Waiting count={waiting.length} />
			{watching && <HomeSeenCheckIn />}
		</SetupScreen>
	);
}

/** One suggestion's row: its icon, its name and the months it came from, and its amount (plain, as P142 draws it). */
function BudgetRow({ ask }: { ask: BudgetAsk }) {
	const months = ask.months
		.map(
			(month) =>
				`${shortMonthName(month.month.slice(0, 7))} ${dollarsWords(month.spentCents)}`,
		)
		.join(" · ");
	return (
		<li class="flex items-center gap-3 border-b border-rule py-2">
			<CategoryIcon icon={ask.icon} color={ask.color} />
			<div class="min-w-0 flex-1 wrap-anywhere">
				<p>{ask.name}</p>
				<p class="text-sm text-muted tabular-nums">{months}</p>
			</div>
			<p class="shrink-0 tabular-nums">
				{dollarsWords(ask.suggestion?.amountCents ?? 0)}
			</p>
		</li>
	);
}

/**
 * Budgets, keep all (P142 A): "Keep these budgets?", the lead on what the suggestions are, the first five suggestions with
 * their icons and months, the rest folded, the double-ruled total, the warning about changing them, and Needs a category. Keep
 * all posts each suggestion the page showed and the month; Go one at a time asks each category in turn.
 */
export function SetupBudgets({
	asks,
	month,
	needs,
	focus,
	watching = false,
	skipped = [],
	idSuffix = "",
}: {
	asks: BudgetAsk[];
	month: string;
	needs: Needs;
	focus: boolean;
	watching?: boolean;
	skipped?: SkippedNote[];
	idSuffix?: string;
}) {
	const shown = asks.slice(0, 5);
	const rest = asks.slice(5);
	const amountOf = (ask: BudgetAsk) => ask.suggestion?.amountCents ?? 0;
	const restCents = rest.reduce((sum, ask) => sum + amountOf(ask), 0);
	const total = budgetsTotalLine(
		asks.length,
		asks.reduce((sum, ask) => sum + amountOf(ask), 0),
	);
	return (
		<SetupScreen
			foot={
				<>
					<form
						id={`budgets${idSuffix}`}
						method="post"
						action="/setup/budgets"
						hx-post="/setup/budgets"
						hx-target="#setup-screen"
						hx-swap="outerHTML"
					>
						{asks.map((ask) => (
							<input type="hidden" name="keep" value={shownBudgetValue(ask)} />
						))}
						<input type="hidden" name="month" value={month} />
						<Button type="submit" name="answer" value="all" class="w-full">
							{keepAllButton(asks.length)}
						</Button>
					</form>
					<div class="mt-1 flex justify-center">
						<Button kind="text" href="/setup?budgets=one">
							Go one at a time
						</Button>
					</div>
				</>
			}
		>
			<StepBar done={3} label={BUDGETS_STEP} />
			<SkippedSteps notes={skipped} />
			<Heading focus={focus}>{keepAllQuestion(asks.length)}</Heading>
			<p class="mt-3 text-muted">{keepAllLead(asks[0]?.months ?? [])}</p>
			<ul class="mt-4 border-t border-rule">
				{shown.map((ask) => (
					<BudgetRow ask={ask} />
				))}
			</ul>
			{rest.length > 0 && (
				<FoldedRow
					label={`${rest.length} more · ${dollarsWords(restCents)} a month`}
				>
					<ul>
						{rest.map((ask) => (
							<BudgetRow ask={ask} />
						))}
					</ul>
				</FoldedRow>
			)}
			<div class="mt-2 flex justify-between border-t-[3px] border-double border-ink pt-2 font-medium">
				<span>{total.label}</span>
				<span class="tabular-nums">{total.amount}</span>
			</div>
			<p class="mt-3 text-sm text-muted">
				Once set, a budget can be changed on Home but not removed.
			</p>
			{needs && <NeedsCategory needs={needs} />}
			{watching && <HomeSeenCheckIn />}
		</SetupScreen>
	);
}

/**
 * One category, one at a time (P142 A, today's OneBudget words): the bank's numbers, the question, and Yes with its suggestion
 * and Another amount, or, with no suggestion, the blank amount and Save this budget; Skip this one is always a form of its own.
 * A refused amount opens Another amount (or the blank field) with its error, and takes focus in the field, not the heading.
 */
export function SetupOneBudget({
	ask,
	month,
	needs,
	focus,
	watching = false,
	skipped = [],
	error,
	amountOpen,
	idSuffix = "",
}: {
	ask: BudgetAsk;
	month: string;
	needs: Needs;
	focus: boolean;
	watching?: boolean;
	skipped?: SkippedNote[];
	error: BudgetError | null;
	/** Another amount drawn open with no error, for the catalog's picture of it. */
	amountOpen: boolean;
	idSuffix?: string;
}) {
	const suggestion = ask.suggestion;
	const typed =
		error?.typed ?? (suggestion ? centsToAmount(suggestion.amountCents) : "");
	const oneForm = `one-budget${idSuffix}`;
	const budgetForm = {
		method: "post",
		action: "/setup/budgets",
		"hx-post": "/setup/budgets",
		"hx-target": "#setup-screen",
		"hx-swap": "outerHTML",
	} as const;
	const category = (
		<input type="hidden" name="category" value={String(ask.id)} />
	);
	const shownMonth = <input type="hidden" name="month" value={month} />;
	const amount = (
		<MoneyInput
			id={`budget-${ask.id}${idSuffix}`}
			name="budget"
			label={`${ask.name}, a month`}
			value={typed}
			error={error?.text}
			autofocus={error !== null}
		/>
	);
	const skip = (
		<form {...budgetForm}>
			{category}
			{shownMonth}
			<div class="mt-1 flex justify-center">
				<Button kind="text" type="submit" name="answer" value="skip">
					Skip this one
				</Button>
			</div>
		</form>
	);
	return (
		<SetupScreen
			foot={
				suggestion ? (
					<>
						<form {...budgetForm}>
							{category}
							{shownMonth}
							<input
								type="hidden"
								name="shown"
								value={String(suggestion.amountCents)}
							/>
							<Button type="submit" name="answer" value="yes" class="w-full">
								{yesLabel(suggestion.amountCents)}
							</Button>
						</form>
						{skip}
					</>
				) : (
					<>
						<Button
							type="submit"
							form={oneForm}
							name="answer"
							value="another"
							class="w-full"
						>
							Save this budget
						</Button>
						{skip}
					</>
				)
			}
		>
			<StepBar done={3} label={BUDGETS_STEP} />
			<SkippedSteps notes={skipped} />
			<Heading focus={focus && error === null} wrap>
				{askHeading(ask)}
			</Heading>
			<p class="mt-3 text-lg text-muted">{bankLine(ask)}</p>
			{suggestion && (
				<p class="mt-2 text-sm text-muted">{suggestionNote(month)}</p>
			)}
			{suggestion ? (
				<details class="mt-6" open={error !== null || amountOpen}>
					<summary class="inline-flex min-h-11 cursor-pointer items-center text-ink">
						Another amount
					</summary>
					<form {...budgetForm}>
						{category}
						{shownMonth}
						<div class="mt-3">{amount}</div>
						<div class="mt-3">
							<Button
								type="submit"
								name="answer"
								value="another"
								class="w-full"
							>
								Save this budget
							</Button>
						</div>
					</form>
				</details>
			) : (
				<form id={oneForm} {...budgetForm}>
					{category}
					{shownMonth}
					<div class="mt-4">{amount}</div>
				</form>
			)}
			{needs && <NeedsCategory needs={needs} />}
			{watching && <HomeSeenCheckIn />}
		</SetupScreen>
	);
}

/**
 * The savings question, the budgets step's last (decision 135, P142 A): "Save some each month?", what Safe to spend does with it,
 * and the money input from the month on, blank. Save it and Not now are two forms, so Enter in the field presses Save it. A
 * refused amount keeps what was typed under its error, and takes focus in the field.
 */
export function SetupSavings({
	month,
	focus,
	watching = false,
	error,
	skipped = [],
	idSuffix = "",
}: {
	month: string;
	focus: boolean;
	watching?: boolean;
	/** A refused Save it: its words and what was typed, kept in the field. */
	error: BudgetError | null;
	skipped?: SkippedNote[];
	idSuffix?: string;
}) {
	const savingsForm = {
		method: "post",
		action: "/setup/savings",
		"hx-post": "/setup/savings",
		"hx-target": "#setup-screen",
		"hx-swap": "outerHTML",
	} as const;
	const shownMonth = <input type="hidden" name="month" value={month} />;
	return (
		<SetupScreen
			foot={
				<>
					<Button
						type="submit"
						form={`savings${idSuffix}`}
						name="answer"
						value="save"
						class="w-full"
					>
						Save it
					</Button>
					<form {...savingsForm}>
						{shownMonth}
						<div class="mt-1 flex justify-center">
							<Button kind="text" type="submit" name="answer" value="skip">
								Not now
							</Button>
						</div>
					</form>
				</>
			}
		>
			<StepBar done={3} label={BUDGETS_STEP} />
			<SkippedSteps notes={skipped} />
			<Heading focus={focus && error === null}>Save some each month?</Heading>
			<p class="mt-3 text-lg text-muted">
				Safe to spend sets it aside from the 1st, before anything else. You can
				change it on Home any time.
			</p>
			<form id={`savings${idSuffix}`} {...savingsForm}>
				{shownMonth}
				<div class="mt-4">
					<MoneyInput
						id={`first-savings${idSuffix}`}
						name="goal"
						label={`Save each month, from ${monthName(month)} on`}
						value={error?.typed ?? ""}
						error={error?.text}
						autofocus={error !== null}
					/>
				</div>
			</form>
			{watching && <HomeSeenCheckIn />}
		</SetupScreen>
	);
}

/** A refused amount in the budgets question: the words under its field, and what was typed (kept in the field). */
export type BudgetError = { text: string; typed: string };

/** The line that names what waits in Possible bills: the count in words, and the link that ends the sentence. */
export function Waiting({ count }: { count: number }) {
	const words = waitingWords(count);
	if (!words) return null;
	return (
		<p class="mt-2 text-sm text-muted">
			{words}{" "}
			<a href="/bills/find" class="text-accent">
				Possible bills
			</a>
			.
		</p>
	);
}

/**
 * The Needs a category line under the budgets question: a link to the Needs category filter across all months (the same
 * count the line shows, needsCategoryCount "all"), then the count and the mean.
 */
export function NeedsCategory({
	needs,
}: {
	needs: { count: number; meanCents: number | null };
}) {
	return (
		<p class="mt-3 text-sm text-muted">
			<a href="/transactions?uncategorized=1&month=all" class="text-accent">
				Needs a category
			</a>
			{needsTail(needs.count, needs.meanCents)}
		</p>
	);
}
