// Home's top during a new family's first week (P125 E, decision 114, spec §8.8). It replaces HomeTop's headline area
// until setup is done: the notebook with the strokes drawn so far, the five lines, and before a bank the one button.
// On the day stroke five is drawn (#586) it is the fifth-day view: Safe to spend, what the night did, and the lines.
// The words come from the setup view (src/first-tally/setup.ts); the catalog draws it from fake views.
import type { Child } from "hono/jsx";
import type { NightCounts } from "../db/first-tally";
import type { SetupView } from "../first-tally/setup";
import { Band } from "./band";
import { BankBehind } from "./bank-line";
import { headlineAmountClass, homeDrawingClass } from "./headline-amount";
import { safeToSpendText } from "./home-top";
import { Notebook } from "./notebook";
import { TallySteps } from "./tally-steps";
import { WhyLink } from "./why-link";

const WORDS = ["None", "One", "Two", "Three", "Four", "Five"];
const count = (n: number) => n.toLocaleString("en-US");

/** The status sentence (serif italic) for the reading, ready and answered states. */
function statusOf(view: SetupView, flagged: boolean): string {
	if (view.phase === "answered") {
		// While a bank is reading its history or needs signing in, the status says what it waits for, not tomorrow (#671).
		if (view.answeredWaiting) {
			return `Four. Tally keeps count ${view.answeredWaiting}`;
		}
		// A flagged bank's line sits under the status with its Fix, so no promise goes beside it: the status is the count (#671).
		return flagged
			? "Four."
			: "Four. Tomorrow Tally keeps count on its own, and that's the fifth.";
	}
	if (view.phase === "ready") {
		return `Tally sorted ${count(view.total)} overnight. Three things to check, and Safe to spend is written in at the end.`;
	}
	const drawn = view.drawn > 0 ? `${WORDS[view.drawn] ?? view.drawn}. ` : "";
	// The bank is named only with one connected: with two, neither is, so the line never names the wrong one.
	const from =
		view.bankCount === 1 ? ` from ${view.bankName ?? "your bank"}` : "";
	const reading = `${drawn}Tally's reading your last 90 days${from}.`;
	// Until every bank's 90-day history is in, no time is promised and no count is shown: the import isn't complete yet.
	if (!view.historyIn) {
		return `${reading} Your questions will be ready once it has read them all and sorted them.`;
	}
	if (!view.fitsOneNight) {
		return `Tally's sorted ${count(view.sorted)} of ${count(view.total)}. Your questions will be ready when it's done, usually in a night or two.`;
	}
	return `${reading} Your questions will usually be ready by the morning.`;
}

/**
 * The fifth day's sentence (#586): what the overnight run did, in words. Nothing needing a person leaves out the rest;
 * otherwise the count says how many do.
 */
export function nightSentence({ brought, needYou }: NightCounts): string {
	const arrived =
		brought === 0
			? "no new transactions"
			: `${count(brought)} new ${brought === 1 ? "transaction" : "transactions"}`;
	if (needYou === 0) {
		return `Five. Overnight Tally kept count on its own: ${arrived}, all sorted. You're set up.`;
	}
	return `Five. Overnight Tally kept count on its own: ${arrived}; ${count(needYou)} ${needYou === 1 ? "needs" : "need"} you.`;
}

/**
 * The fifth-day view (#586, P125 E): Safe to spend beside the five-stroke notebook, the night's sentence, the link to what
 * needs a person when there is any, the five lines with today's day on the fifth, and the note that from tomorrow Home is
 * Home. The sentence is plain text under the sr-only heading; nothing is swapped, so nothing is announced.
 */
function FifthDay({
	view,
	night,
	safeToSpendCents,
	needsHref,
	bankLine,
}: {
	view: SetupView;
	night: NightCounts;
	safeToSpendCents: number;
	needsHref: string;
	bankLine?: string[];
}) {
	const amount = safeToSpendText(safeToSpendCents);
	return (
		<section class="mt-2" aria-labelledby="setup-title">
			<h1 id="setup-title" class="sr-only">
				Your first week
			</h1>
			<div class="flex items-center justify-between gap-4">
				<div class="min-w-0">
					<p class="text-lg text-muted">
						Safe to spend · <WhyLink section="budget" topic="safe to spend" />
					</p>
					<p
						class={`font-serif text-6xl font-semibold tracking-tight lg:text-7xl ${headlineAmountClass(amount)}`}
					>
						<span class="whitespace-nowrap">{amount}</span>
					</p>
				</div>
				{/* Hidden below 390px, and wider for longer amounts, as Home's notebook is (decision 116). */}
				<div class={`hidden shrink-0 ${homeDrawingClass(amount)}`}>
					<Notebook strokes={5} ink size="size-24" />
				</div>
			</div>
			<p id="setup-status" class="mt-3 font-serif text-lg italic">
				{nightSentence(night)}
			</p>
			{night.needYou > 0 && (
				<p class="mt-2">
					<a
						href={needsHref}
						class="inline-flex min-h-11 items-center text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						See what needs you
					</a>
				</p>
			)}
			{bankLine && <BankBehind words={bankLine} />}
			<TallySteps steps={view.steps} />
			<p class="mt-4 text-sm text-muted">
				From tomorrow this list goes, and Home is just Home.
			</p>
		</section>
	);
}

/**
 * The setup top. `linkBank` is Home's Link a bank (before a bank, and only when Plaid is on): the one button, with its
 * error region. `bankLine` is a connected bank that stopped syncing or needs signing in (src/stale-bank.ts), said as
 * Home's top says it, with its Fix. Its words lead, so while one is drawn the reading's "Nothing for you to do until
 * then." is left out, since a bank that needs a fix is something to do. The status takes focus after Plaid redraws
 * Home (`data-link-bank-focus`, plaid-link.js). `fifthDay` is the money and the link the fifth-day view draws (Home's
 * Safe to spend, and where "See what needs you" goes); it is given only on the day stroke five is drawn.
 */
export function HomeSetup({
	view,
	linkBank,
	bankLine,
	fifthDay,
}: {
	view: SetupView;
	linkBank?: Child;
	bankLine?: string[];
	fifthDay?: { safeToSpendCents: number; needsHref: string };
}) {
	if (view.fifth && fifthDay) {
		return (
			<FifthDay
				view={view}
				night={view.fifth}
				safeToSpendCents={fifthDay.safeToSpendCents}
				needsHref={fifthDay.needsHref}
				bankLine={bankLine}
			/>
		);
	}
	const { phase } = view;
	const before = phase === "before";
	return (
		<section class="mt-2" aria-labelledby="setup-title">
			{/* The picked drawing shows no title once a bank is linked: the heading is for screen readers, the notebook at the right. */}
			<div
				class={`flex items-center gap-4 ${before ? "justify-between" : "justify-end"}`}
			>
				<h1
					id="setup-title"
					class={
						before
							? "min-w-0 font-serif text-4xl font-semibold tracking-tight"
							: "sr-only"
					}
				>
					{before ? "Five strokes, and you're set up." : "Your first week"}
				</h1>
				<Notebook strokes={view.drawn} ink size="size-24" />
			</div>
			{phase !== "before" && (
				<>
					<p
						id="setup-status"
						tabindex={-1}
						data-link-bank-focus
						class="mt-3 font-serif text-lg italic"
					>
						{statusOf(view, Boolean(bankLine))}
					</p>
					{phase === "reading" && !bankLine && (
						<p class="mt-2 text-muted">Nothing for you to do until then.</p>
					)}
				</>
			)}
			{bankLine && <BankBehind words={bankLine} />}
			<TallySteps steps={view.steps} />
			{phase === "before" && linkBank && (
				<div class="mt-6">
					{linkBank}
					<p class="mt-3 text-sm text-muted">
						Tally can only read your bank. It can't move money.
					</p>
				</div>
			)}
			{phase === "ready" && (
				<div class="mt-4">
					<Band
						href="/first-page"
						detail="Your pay, your bills and your budgets. About three minutes."
					>
						Three things to check
					</Band>
				</div>
			)}
		</section>
	);
}
