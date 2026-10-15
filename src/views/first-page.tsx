// The question page at /first-page (P125 E, spec §8.8, decision 114): "Your first page", the notebook with its count,
// the ledger of answers so far, and one question at a time. Each answer swaps the whole page (#first-page), so the
// count, the ledger and the next question all come from the same reading. The proposals page draws these same pieces
// (FirstPage, SmallNotebook, LedgerLine), so the drawing and the app can't drift.
import type { Child } from "hono/jsx";
import type { BillSuggestion } from "../bills/find";
import { shortDay } from "../dates";
import {
	billsMutedLine,
	keepHeading,
	waitingSentence,
} from "../first-tally/bills";
import type {
	BankHead,
	FirstPageModel,
	PayMerchant,
} from "../first-tally/first-page";
import { paySentence } from "../first-tally/pay";
import { Button } from "./button";
import { Notebook } from "./notebook";

/** One line of a ledger: an answer (ink) or what the bank says (muted). */
export type LedgerLine = { text: string; ink?: boolean };

/** The notebook beside a question page's headline, with what it counts in words beside it. */
export function SmallNotebook({
	strokes,
	text,
	size = "size-12",
}: {
	strokes: number;
	text: string;
	size?: string;
}) {
	return (
		<div class="flex items-center gap-2">
			<Notebook strokes={strokes} ink size={size} />
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
}: {
	right?: Child;
	lines: LedgerLine[];
	children?: Child;
}) {
	return (
		<>
			<div class="flex items-center justify-between gap-3">
				<h1 class="text-lg font-semibold">Your first page</h1>
				{right}
			</div>
			{lines.length > 0 ? (
				<ul class="mt-3 divide-y divide-rule border-y border-rule text-sm">
					{lines.map((line) => (
						<li class={`py-2 ${line.ink ? "text-ink" : "text-muted"}`}>
							{line.text}
						</li>
					))}
				</ul>
			) : null}
			{children}
		</>
	);
}

/**
 * The ledger's lines: the answers so far in ink; before any answer, the bank's head lines in muted words.
 */
export function ledgerLines(
	answers: string[],
	head: BankHead | null,
): LedgerLine[] {
	if (answers.length > 0) return answers.map((text) => ({ text, ink: true }));
	if (!head) return [];
	const count = head.lines === 1 ? "1 line" : `${head.lines} lines`;
	return [
		{
			text: `From ${head.banks} · ${count} · ${shortDay(head.first, head.last)} to ${shortDay(head.last, head.last)}`,
		},
		{ text: `Moves between your accounts · ${head.left} left out` },
	];
}

/** The pay question for one merchant: what the bank shows, "Is this your pay?", and Yes or No. */
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
	const waits = waitingSentence(waiting.length);
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
			{waits ? <p class="mt-2 text-sm text-muted">{waits}</p> : null}
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
	const waits = waitingSentence(waiting);
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
			{waits ? (
				<p class="mt-2 text-sm text-muted">
					{waits}{" "}
					<a href="/bills/find" class="text-accent">
						Possible bills
					</a>
				</p>
			) : null}
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
	const waits = waitingSentence(waiting);
	return (
		<section>
			<h2
				tabindex={-1}
				autofocus={focus}
				class="mt-6 font-serif text-2xl font-semibold"
			>
				Pay and bills are done.
			</h2>
			{waits ? (
				<p class="mt-2 text-sm text-muted">
					{waits}{" "}
					<a href="/bills/find" class="text-accent">
						Possible bills
					</a>
				</p>
			) : null}
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
}: {
	model: FirstPageModel;
	focus: boolean;
}) {
	const billsAnswered = model.ledger.some((line) =>
		line.startsWith("Bills · "),
	);
	return (
		<div id="first-page">
			<FirstPage
				right={
					<SmallNotebook
						strokes={model.drawn}
						text={`${model.drawn} of 5`}
						size="size-20"
					/>
				}
				lines={ledgerLines(model.ledger, model.head)}
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
								focus={focus}
							/>
						) : billsAnswered ? (
							<FirstPageDone waiting={model.waiting.length} focus={focus} />
						) : (
							<BillsEmpty waiting={model.waiting.length} focus={focus} />
						)}
					</>
				)}
			</FirstPage>
		</div>
	);
}
