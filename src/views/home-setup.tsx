// Home's top once a new family's three questions are answered (P125 E, decision 114, spec §8.8). It replaces HomeTop's headline
// area until the five strokes are drawn: the notebook with the strokes drawn so far, the status, and the five lines. On the day
// stroke five is drawn (#586) it is the fifth-day view: Safe to spend, what the night did, and the lines. Before the questions
// are answered, setup has its own screens (setup-welcome.tsx, setup-reading.tsx, /setup). The words come from the setup view
// (src/first-tally/setup.ts); the catalog draws it from fake views.
import type { NightCounts } from "../db/first-tally";
import { nightCountWords, type SetupView } from "../first-tally/setup";
import { BankBehind } from "./bank-line";
import { headlineAmountClass, homeDrawingClass } from "./headline-amount";
import { safeToSpendText } from "./home-top";
import { Notebook } from "./notebook";
import { TallySteps } from "./tally-steps";
import { WhyLink } from "./why-link";

/**
 * The status sentence (serif italic) once the three questions are answered (decision 146): the count, and what Tally waits for
 * while a bank reads its history or needs signing in (#671).
 */
export function statusOf(view: SetupView, flagged: boolean): string {
	// While a bank is reading its history or needs signing in, the status says what it waits for, not tomorrow (#671).
	if (view.answeredWaiting)
		return `Four. Tally keeps count ${view.answeredWaiting}`;
	// A flagged bank's line sits under the status with its Fix, so no promise goes beside it: the status is the count (#671).
	return flagged
		? "Four."
		: "Four. Tomorrow Tally keeps count on its own, and that's the fifth.";
}

/**
 * The fifth day's sentence (#586): what the overnight run did, in words. Nothing needing a person leaves out the rest;
 * otherwise the count says how many do.
 */
export function nightSentence(counts: NightCounts): string {
	const words = nightCountWords(counts);
	if (counts.needYou === 0) {
		return `Five. Overnight Tally kept count on its own: ${words}. You're set up.`;
	}
	return `Five. Overnight Tally kept count on its own: ${words}.`;
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
	focusStatus = false,
}: {
	view: SetupView;
	night: NightCounts;
	safeToSpendCents: number;
	/** Where "See what needs you" goes, given when the night left something for a person (home.tsx). */
	needsHref?: string;
	bankLine?: string[];
	/** The night's sentence takes focus: a full redraw of Home on the fifth day (home.tsx). */
	focusStatus?: boolean;
}) {
	const amount = safeToSpendText(safeToSpendCents);
	return (
		<section id="setup-top" class="mt-2" aria-labelledby="setup-title">
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
			<p
				id="setup-status"
				class="mt-3 font-serif text-lg italic"
				tabindex={focusStatus ? -1 : undefined}
				autofocus={focusStatus}
			>
				{nightSentence(night)}
			</p>
			{night.needYou > 0 && needsHref && (
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
 * Home's top once the three questions are answered (decision 114, #586): Safe to spend beside the notebook, the status, and the
 * five lines. Before the fifth day it is the answered view (the count line waits for the night, and a bank still reading its
 * history or needing a sign-in says what Tally waits for, #671). On the day stroke five is drawn it is the fifth-day view
 * (FifthDay). Setup's other phases are on its own screens (/setup). `bankLine` is a connected bank that stopped syncing or needs
 * signing in (src/stale-bank.ts), with its Fix (BankBehind). `fifthDay` is the money and the link the fifth-day view draws; it is
 * given only on the day stroke five is drawn. `focusStatus` is given only by a full redraw that moved the top on, so the status
 * takes focus; a full load never sets it.
 */
export function HomeSetup({
	view,
	bankLine,
	fifthDay,
	focusStatus = false,
}: {
	view: SetupView;
	bankLine?: string[];
	fifthDay?: { safeToSpendCents: number; needsHref?: string };
	focusStatus?: boolean;
}) {
	if (view.fifth && fifthDay) {
		return (
			<FifthDay
				view={view}
				night={view.fifth}
				safeToSpendCents={fifthDay.safeToSpendCents}
				needsHref={fifthDay.needsHref}
				bankLine={bankLine}
				focusStatus={focusStatus}
			/>
		);
	}
	return (
		<section id="setup-top" class="mt-2" aria-labelledby="setup-title">
			<div class="flex items-center justify-end gap-4">
				<h1 id="setup-title" class="sr-only">
					Your first week
				</h1>
				<Notebook strokes={view.drawn} ink size="size-24" />
			</div>
			<p
				id="setup-status"
				tabindex={focusStatus ? -1 : undefined}
				autofocus={focusStatus}
				class="mt-3 font-serif text-lg italic"
			>
				{statusOf(view, Boolean(bankLine))}
			</p>
			{bankLine && <BankBehind words={bankLine} />}
			<TallySteps steps={view.steps} />
		</section>
	);
}
