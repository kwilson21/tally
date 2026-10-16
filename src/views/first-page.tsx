// The question page at /first-page (P125 E, spec §8.8, decision 114): "Your first page", the notebook with its count,
// the ledger of answers so far, and one question at a time. Each answer swaps the whole page (#first-page), so the
// count, the ledger and the next question all come from the same reading. The proposals page draws these same pieces
// (FirstPage, SmallNotebook, LedgerLine), so the drawing and the app can't drift.
import type { Child } from "hono/jsx";
import type { BillSuggestion } from "../bills/find";
import { shortDay, shortMonthName } from "../dates";
import {
	billsMutedLine,
	keepHeading,
	shownBillValue,
	waitingWords,
} from "../first-tally/bills";
import {
	askHeading,
	type BudgetAsk,
	bankLine,
	keepAllHeading,
	keepAllLine,
	needsTail,
	RULED_STATUS,
	shownBudgetValue,
	suggestionNote,
	yesLabel,
} from "../first-tally/budgets";
import type {
	BankHead,
	BudgetsStep,
	FirstPageModel,
	PayMerchant,
} from "../first-tally/first-page";
import { dollarsWords, paySentence, shownPayValues } from "../first-tally/pay";
import { centsToAmount } from "../money";
import { Button } from "./button";
import { FoldedRow } from "./folded-row";
import { safeToSpendText } from "./home-top";
import { MoneyInput } from "./money-input";
import { Notebook } from "./notebook";
import { WhyLink } from "./why-link";

/** One line of a ledger: an answer (ink) or what the bank says (muted). */
export type LedgerLine = { text: string; ink?: boolean };

/**
 * What a reply changed, for its one-shot motion: the index of the ledger line it wrote (it rises in, null when it wrote
 * none), and the notebook's strokes it drew (their indexes in the five, which draw in pencil and then ink). A page that
 * isn't a reply has none.
 */
export type Motion = { line: number | null; strokes: number[] };
export const NO_MOTION: Motion = { line: null, strokes: [] };

/** The notebook beside a question page's headline, with what it counts in words beside it. */
export function SmallNotebook({
	strokes,
	text,
	size = "size-12",
	justDrawn = [],
}: {
	strokes: number;
	text: string;
	size?: string;
	/** The strokes this reply drew (their indexes), which draw in pencil and then ink; none on any other page. */
	justDrawn?: number[];
}) {
	return (
		<div class="flex items-center gap-2">
			<Notebook
				strokes={strokes}
				ink
				size={size}
				lineClass={(line) =>
					`stroke-ink${justDrawn.includes(line) ? " first-stroke-new" : ""}`
				}
			/>
			<p class="text-sm text-muted">{text}</p>
		</div>
	);
}

/**
 * A question page's top (P125 E): "Your first page", the count at the right, and the ledger so far. The ledger is left
 * out while it has no lines. `children` is the question.
 */
export function FirstPage({
	right,
	lines,
	children,
	fresh = null,
}: {
	right?: Child;
	lines: LedgerLine[];
	children?: Child;
	/** A reply's page: the index of the line it wrote, which rises in. */
	fresh?: number | null;
}) {
	return (
		<>
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-lg font-semibold">Your first page</h1>
				{right}
			</div>
			{lines.length > 0 ? (
				<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
					{lines.map((line, i) => (
						<li
							class={`py-2 ${line.ink ? "text-ink" : "text-muted"}${i === fresh ? " first-line-new" : ""}`}
						>
							{line.text}
						</li>
					))}
				</ul>
			) : null}
			{children}
		</>
	);
}

/** The line that names what waits in Possible bills: the count in words, and the link that ends the sentence. */
function Waiting({ count }: { count: number }) {
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
 * The ledger's lines: the answers so far in ink; before any answer, the bank's head lines in muted words.
 */
export function ledgerLines(
	answers: { text: string }[],
	head: BankHead | null,
): LedgerLine[] {
	if (answers.length > 0)
		return answers.map((line) => ({ text: line.text, ink: true }));
	if (!head) return [];
	const count = head.lines === 1 ? "1 line" : `${head.lines} lines`;
	return [
		{
			text: `From ${head.banks} · ${count} · ${shortDay(head.first, head.last)} to ${shortDay(head.last, head.last)}`,
		},
		{ text: `Moves between your accounts · ${head.left} left out` },
	];
}

/**
 * The pay question for one merchant: what the bank shows, "Is this your pay?", and Yes or No. The form carries one
 * `deposit` field per deposit shown, so an answer covers only those (the POST checks them against the deposits then).
 */
export function PayQuestion({
	merchant,
	focus,
}: {
	merchant: PayMerchant;
	focus: boolean;
}) {
	return (
		<section>
			<p class="mt-6 text-base text-muted">
				{paySentence({ bankText: merchant.key, deposits: merchant.deposits })}
			</p>
			<h2
				tabindex={-1}
				autofocus={focus}
				class="mt-3 font-serif text-2xl font-semibold"
			>
				Is this your pay?
			</h2>
			<form
				method="post"
				action="/first-page/pay"
				hx-post="/first-page/pay"
				hx-target="#first-page"
				hx-swap="outerHTML"
			>
				<input type="hidden" name="merchant" value={merchant.key} />
				{shownPayValues(merchant).map((value) => (
					<input type="hidden" name="deposit" value={value} />
				))}
				<div class="mt-4">
					<Button type="submit" name="answer" value="yes" class="w-full">
						Yes, that's my pay
					</Button>
				</div>
				<div class="mt-1">
					<Button kind="text" type="submit" name="answer" value="no">
						No, it's something else
					</Button>
				</div>
			</form>
		</section>
	);
}

/** Pay with nothing spotted: the step says so, and counts as done (P125 E). */
export function PayEmpty() {
	return (
		<section>
			<h2 class="mt-6 font-serif text-2xl font-semibold">Your pay</h2>
			<p class="mt-2 text-base text-muted">
				Tally didn't spot a paycheck. You can mark one from any transaction
				later.
			</p>
		</section>
	);
}

/** The bills question: the found charges, "Keep these N as bills?", the one-tap keep, and Choose which. */
export function BillsQuestion({
	keep,
	waiting,
	focus,
}: {
	keep: BillSuggestion[];
	waiting: BillSuggestion[];
	focus: boolean;
}) {
	return (
		<section>
			<p class="mt-6 text-base text-muted">
				{billsMutedLine([...keep, ...waiting])}
			</p>
			<h2
				tabindex={-1}
				autofocus={focus}
				class="mt-3 font-serif text-2xl font-semibold"
			>
				{keepHeading(keep.length)}
			</h2>
			<form
				method="post"
				action="/first-page/bills"
				hx-post="/first-page/bills"
				hx-target="#first-page"
				hx-swap="outerHTML"
			>
				{keep.map((suggestion) => (
					<input type="hidden" name="keep" value={shownBillValue(suggestion)} />
				))}
				<div class="mt-4">
					<Button type="submit" class="w-full">
						{keep.length === 1 ? "Keep this one" : `Keep these ${keep.length}`}
					</Button>
				</div>
			</form>
			<div class="mt-1">
				<Button kind="text" href="/bills/find">
					Choose which
				</Button>
			</div>
			<Waiting count={waiting.length} />
		</section>
	);
}

/** Bills with nothing to keep in one tap: the step says so, names what waits in Possible bills, and counts as done. */
export function BillsEmpty({
	waiting,
	focus,
}: {
	waiting: number;
	focus: boolean;
}) {
	return (
		<section>
			<h2
				tabindex={-1}
				autofocus={focus}
				class="mt-6 font-serif text-2xl font-semibold"
			>
				Your bills
			</h2>
			<p class="mt-2 text-base text-muted">Nothing here to keep in one tap.</p>
			<Waiting count={waiting} />
		</section>
	);
}

/** Pay and bills are both done. */
export function FirstPageDone({
	waiting,
	focus,
}: {
	waiting: number;
	focus: boolean;
}) {
	return (
		<section>
			<h2
				tabindex={-1}
				autofocus={focus}
				class="mt-6 font-serif text-2xl font-semibold"
			>
				Pay and bills are done.
			</h2>
			<Waiting count={waiting} />
		</section>
	);
}

/** A refused amount in the budgets question: the words under its field, and what was typed (kept in the field). */
export type BudgetError = { text: string; typed: string };

/** One suggestion's row in the keep all list: its name, the months it came from, and the amount Tally suggests. */
function SuggestionRow({ ask }: { ask: BudgetAsk }) {
	const months = ask.months
		.map(
			(month) =>
				`${shortMonthName(month.month.slice(0, 7))} ${dollarsWords(month.spentCents)}`,
		)
		.join(" · ");
	return (
		<li class="flex items-center justify-between gap-3 py-1">
			<div class="min-w-0">
				<p class="text-base">{ask.name}</p>
				<p class="text-sm text-muted">{months}</p>
			</div>
			<span class="shrink-0 rounded-full border border-dashed border-muted px-3 py-0.5 text-sm text-muted">
				{dollarsWords(ask.suggestion?.amountCents ?? 0)}
				<span class="sr-only">Suggested, not kept yet</span>
			</span>
		</li>
	);
}

/** The Needs a category line under the budgets question: a link to the Needs category filter, then the count and the mean. */
function NeedsCategory({
	needs,
}: {
	needs: { count: number; meanCents: number | null };
}) {
	return (
		<p class="mt-3 text-sm text-muted">
			<a href="/transactions?uncategorized=1" class="text-accent">
				Needs a category
			</a>
			{needsTail(needs.count, needs.meanCents)}
		</p>
	);
}

/**
 * The keep all question (spec §8.8, #590): the suggestions as a list (the first five; the rest folded), the total in the
 * question, the one tap "Keep all N", and a quiet "One at a time" that asks each category in turn.
 */
function KeepAllBudgets({
	asks,
	needs,
	focus,
}: {
	asks: BudgetAsk[];
	needs: { count: number; meanCents: number | null } | null;
	focus: boolean;
}) {
	const total = asks.reduce(
		(sum, ask) => sum + (ask.suggestion?.amountCents ?? 0),
		0,
	);
	const shown = asks.slice(0, 5);
	const rest = asks.slice(5);
	const restTotal = rest.reduce(
		(sum, ask) => sum + (ask.suggestion?.amountCents ?? 0),
		0,
	);
	return (
		<section>
			<p class="mt-6 text-base text-muted">
				{keepAllLine(asks[0]?.months ?? [])}
			</p>
			<ul class="mt-3 divide-y divide-rule border-y border-rule">
				{shown.map((ask) => (
					<SuggestionRow ask={ask} />
				))}
			</ul>
			{rest.length > 0 && (
				<FoldedRow
					label={`${rest.length} more · ${dollarsWords(restTotal)} a month`}
				>
					<ul class="divide-y divide-rule">
						{rest.map((ask) => (
							<SuggestionRow ask={ask} />
						))}
					</ul>
				</FoldedRow>
			)}
			<h2
				tabindex={-1}
				autofocus={focus}
				class="mt-3 font-serif text-xl font-semibold"
			>
				{keepAllHeading(asks.length, total)}
			</h2>
			<form
				method="post"
				action="/first-page/budgets"
				hx-post="/first-page/budgets"
				hx-target="#first-page"
				hx-swap="outerHTML"
			>
				{asks.map((ask) => (
					<input type="hidden" name="keep" value={shownBudgetValue(ask)} />
				))}
				<div class="mt-3">
					<Button type="submit" name="answer" value="all" class="w-full">
						Keep all {asks.length}
					</Button>
				</div>
			</form>
			<div class="mt-1">
				<Button kind="text" href="/first-page?budgets=one">
					One at a time
				</Button>
			</div>
			<p class="mt-3 text-sm text-muted">
				Once set, a budget can be changed on Home but not removed.
			</p>
			{needs && <NeedsCategory needs={needs} />}
		</section>
	);
}

/**
 * One category's question, one at a time (spec §8.8, #590): what the bank shows it spent, its suggestion in a dashed tag
 * and the question, "Yes, $650" and Another amount (the real MoneyInput, opened in place), or, with no suggestion, the
 * blank MoneyInput; then a quiet Skip this one. A refused amount keeps the question with its error in the field.
 */
function OneBudget({
	ask,
	month,
	needs,
	focus,
	error,
}: {
	ask: BudgetAsk;
	month: string;
	needs: { count: number; meanCents: number | null } | null;
	focus: boolean;
	error: BudgetError | null;
}) {
	const suggestion = ask.suggestion;
	const typed =
		error?.typed ?? (suggestion ? centsToAmount(suggestion.amountCents) : "");
	const amount = (
		<MoneyInput
			id={`budget-${ask.id}`}
			name="budget"
			label={`${ask.name}, a month`}
			value={typed}
			error={error?.text}
			autofocus={error !== null}
		/>
	);
	return (
		<section>
			<p class="mt-6 text-base text-muted">{bankLine(ask)}</p>
			{suggestion && (
				<p class="mt-2">
					<span class="inline-flex items-center rounded-full border border-dashed border-muted px-3 py-1 text-sm text-muted">
						{dollarsWords(suggestion.amountCents)} a month
						<span class="sr-only">Suggested, not kept yet</span>
					</span>
				</p>
			)}
			<h2
				tabindex={-1}
				autofocus={focus && error === null}
				class="mt-3 font-serif text-2xl font-semibold"
			>
				{askHeading(ask)}
			</h2>
			{suggestion && (
				<p class="mt-2 text-sm text-muted">{suggestionNote(month)}</p>
			)}
			<form
				method="post"
				action="/first-page/budgets"
				hx-post="/first-page/budgets"
				hx-target="#first-page"
				hx-swap="outerHTML"
			>
				<input type="hidden" name="category" value={String(ask.id)} />
				{suggestion && (
					<input
						type="hidden"
						name="shown"
						value={String(suggestion.amountCents)}
					/>
				)}
				{suggestion ? (
					<>
						<div class="mt-4">
							<Button type="submit" name="answer" value="yes" class="w-full">
								{yesLabel(suggestion.amountCents)}
							</Button>
						</div>
						<details class="mt-3" open={error !== null}>
							<summary class="inline-flex min-h-11 cursor-pointer items-center text-ink">
								Another amount
							</summary>
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
						</details>
					</>
				) : (
					<>
						<div class="mt-4">{amount}</div>
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
					</>
				)}
				<div class="mt-1">
					<Button kind="text" type="submit" name="answer" value="skip">
						Skip this one
					</Button>
				</div>
			</form>
			{needs && <NeedsCategory needs={needs} />}
		</section>
	);
}

/**
 * The budgets step's question: the keep all question while it is the one asked, else the next category. Nothing is asked
 * once the budgets stroke is drawn (RuledTotal takes its place).
 */
export function BudgetsQuestion({
	step,
	focus,
	error,
}: {
	step: Extract<BudgetsStep, { done: false }>;
	focus: boolean;
	error: BudgetError | null;
}) {
	if (step.keepAllOpen)
		return (
			<KeepAllBudgets
				asks={step.asks.filter((ask) => ask.suggestion !== null)}
				needs={step.needs}
				focus={focus}
			/>
		);
	const next = step.asks[0];
	if (!next) return null;
	return (
		<OneBudget
			ask={next}
			month={step.month}
			needs={step.needs}
			focus={focus}
			error={error}
		/>
	);
}

/**
 * The ruled-off total (spec §8.8, #590): a double rule, the month's Safe to spend (the number Home shows), the Four line,
 * and a way back to Home. It is drawn once the budgets stroke is.
 */
export function RuledTotal({
	safeCents,
	focus,
}: {
	safeCents: number;
	focus: boolean;
}) {
	return (
		<section>
			<div class="mt-6 border-b-[3px] border-double border-ink" />
			<p tabindex={-1} autofocus={focus} class="mt-4 text-lg text-muted">
				Safe to spend · <WhyLink section="budget" topic="safe to spend" />
			</p>
			<p class="font-serif text-6xl font-semibold tracking-tight">
				{safeToSpendText(safeCents)}
			</p>
			<p class="mt-3 font-serif text-lg italic">{RULED_STATUS}</p>
			<div class="mt-6">
				<Button href="/" class="w-full">
					Go to Home
				</Button>
			</div>
		</section>
	);
}

/**
 * The page's body, from its root `#first-page` down: the heading, the ledger, and the one question that is next. `focus`
 * is true on a swap, so the next question's heading takes focus (toast.js focuses [autofocus] after a swap).
 */
export function FirstPageBody({
	model,
	focus,
	motion = NO_MOTION,
	id = "first-page",
	budgetError = null,
}: {
	model: FirstPageModel;
	focus: boolean;
	/** What the reply changed (NO_MOTION on a page load), so only the reply's own line and stroke animate. */
	motion?: Motion;
	/** The root's id: the page's is `first-page`, which the swap targets; the catalog's states name their own. */
	id?: string;
	/** A refused "another amount" in the budgets question: its words and what was typed, so the field keeps it. */
	budgetError?: BudgetError | null;
}) {
	const billsAnswered = model.ledger.some((line) => line.id === "bills");
	const budgets = model.budgets;
	// Pay and bills come before the budgets question, so only the last question on the page takes the focus.
	const stepFocus = focus && budgets === null;
	return (
		<div id={id}>
			<FirstPage
				right={
					<SmallNotebook
						strokes={model.drawn}
						text={`${model.drawn} of 5`}
						size="size-20"
						justDrawn={motion.strokes}
					/>
				}
				lines={ledgerLines(model.ledger, model.head)}
				fresh={motion.line}
			>
				{model.pay.length > 0 && model.pay[0] ? (
					<PayQuestion merchant={model.pay[0]} focus={focus} />
				) : (
					<>
						{model.payAnswered ? null : <PayEmpty />}
						{model.keep.length > 0 ? (
							<BillsQuestion
								keep={model.keep}
								waiting={model.waiting}
								focus={stepFocus}
							/>
						) : billsAnswered ? (
							<FirstPageDone waiting={model.waiting.length} focus={stepFocus} />
						) : (
							<BillsEmpty waiting={model.waiting.length} focus={stepFocus} />
						)}
						{budgets &&
							(budgets.done ? (
								<RuledTotal safeCents={budgets.safeCents} focus={focus} />
							) : (
								<BudgetsQuestion
									step={budgets}
									focus={focus}
									error={budgetError ?? null}
								/>
							))}
					</>
				)}
			</FirstPage>
		</div>
	);
}
