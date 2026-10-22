// Home's top during a new family's first week (P125 E, decision 114, spec §8.8). It replaces HomeTop's headline area
// until setup is done: the notebook with the strokes drawn so far, the five lines, and before a bank the one button.
// On the day stroke five is drawn (#586) it is the fifth-day view: Safe to spend, what the night did, and the lines.
// The words come from the setup view (src/first-tally/setup.ts); the catalog draws it from fake views.
import type { Child } from "hono/jsx";
import type { NightCounts } from "../db/first-tally";
import { nightCountWords, type SetupView } from "../first-tally/setup";
import type { YourBank } from "../first-tally/your-banks";
import { Band } from "./band";
import { BankBehind } from "./bank-line";
import { headlineAmountClass, homeDrawingClass } from "./headline-amount";
import { HomeSeenCheckIn } from "./home-seen";
import { safeToSpendText } from "./home-top";
import { Notebook } from "./notebook";
import { NotifyControl, type NotifyShown } from "./notify-control";
import { TallySteps } from "./tally-steps";
import { WhyLink } from "./why-link";
import { YourBanks } from "./your-banks";

const count = (n: number) => n.toLocaleString("en-US");

/** Home's headline before a bank is linked (decision 114). Home's announce for a redraw to it uses these words too. */
export const BEFORE_HEADLINE = "Five strokes, and you're set up.";

/**
 * The ready status (decision 146): every transaction the banks sent is sorted, and the three questions are next. The count
 * reads as a sentence: "Your 1 transaction", "Everything" when there are none.
 */
export function readyStatus(total: number): string {
	const sorted =
		total === 1
			? "Your 1 transaction is sorted."
			: total === 0
				? "Everything is sorted."
				: `All ${count(total)} transactions are sorted.`;
	return `${sorted} Now answer three quick questions to set up your budget.`;
}

/**
 * The step the reading phase shows (decision 146): sorting once every history is in and something waits, slow once the
 * newest history is over an hour old, otherwise reading. The banks refresh's poll names it, so a change is announced once.
 */
export function setupStep(view: SetupView): "reading" | "sorting" | "slow" {
	return view.slow ? "slow" : view.sorting ? "sorting" : "reading";
}

/**
 * The line under the status in the reading phase (decision 146): what Tally does next, and whether this page updates as it
 * goes and whether an email comes. A sort says its own line, and a slow sort says that Tally keeps trying on its own, with no
 * time promised. "Nothing for you to do." is left out while a bank line with its Fix is drawn (bankLine).
 */
export function setupNextLine(view: SetupView, bankLine: boolean): string {
	if (view.slow) {
		const email = view.emailed
			? "."
			: " and will email you the moment your questions are ready.";
		return `Tally keeps trying on its own${email}${bankLine ? "" : " Nothing for you to do."}`;
	}
	if (view.sorting) {
		const stay =
			view.refreshes && !view.emailed
				? " Stay here, or Tally will email you."
				: "";
		return `Your three questions open the moment it's done, usually in a few minutes.${stay}`;
	}
	const sentences = [
		"Next it sorts them, then you answer three quick questions and your budget is ready.",
	];
	const updates = view.refreshes;
	const email = !view.emailed;
	if (updates && email)
		sentences.push(
			"This page updates as it goes, and Tally will email you the moment they're ready.",
		);
	else if (updates) sentences.push("This page updates as it goes.");
	else if (email)
		sentences.push("Tally will email you the moment they're ready.");
	return sentences.join(" ");
}

/** The status sentence (serif italic) for the reading, ready and answered states. */
export function statusOf(view: SetupView, flagged: boolean): string {
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
	if (view.phase === "ready") return readyStatus(view.total);
	if (view.slow)
		return `Sorting is taking longer than usual: ${count(view.sorted)} of ${count(view.total)}.`;
	if (view.sorting)
		return `Sorting your last 90 days: ${count(view.sorted)} of ${count(view.total)} done.`;
	// The bank is named only with one connected; with more, the count says how many (P140 A).
	const from =
		view.bankCount === 1
			? ` from ${view.bankName ?? "your bank"}`
			: view.bankCount > 1
				? ` from ${count(view.bankCount)} banks`
				: "";
	return `Tally's reading your last 90 days${from}.`;
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
 * The setup top. `linkBank` is Home's Link a bank (before a bank, and only when Plaid is on): the one button, with its
 * error region. `bankLine` is a connected bank that stopped syncing or needs signing in (src/stale-bank.ts), said as
 * Home's top says it, with its Fix. Its words lead, so while one is drawn the slow line leaves out "Nothing for you to
 * do.", since a bank that needs a fix is something to do. The status takes focus after Plaid redraws Home
 * (`data-link-bank-focus`, plaid-link.js). `fifthDay` is the money and the link the fifth-day view draws (Home's Safe
 * to spend, and where "See what needs you" goes); it is given only on the day stroke five is drawn. `focusStatus` is
 * given only by the refresh that redraws the top once the questions open (home.tsx): the status is autofocus there, so
 * htmx moves focus to it once the swap lands, since the button that had it (Link a bank, a Fix) has been removed. A
 * full load never sets it, so Home never takes focus on load.
 */
export function HomeSetup({
	view,
	linkBank,
	bankLine,
	fifthDay,
	yourBanks,
	focusStatus = false,
	polls = true,
	notify,
}: {
	view: SetupView;
	linkBank?: Child;
	bankLine?: string[];
	fifthDay?: { safeToSpendCents: number; needsHref?: string };
	/**
	 * Notify me on this device (decision 148): drawn only in the reading phase, and only when the server has Web Push keys (Home
	 * passes it then, never in the demo). `shown` is for the catalog's drawings alone.
	 */
	notify?: { vapidKey: string; shown?: NotifyShown; idSuffix?: string };
	/** The connected banks' rows and today's date, drawn while the import is read (YourBanks). */
	yourBanks?: {
		banks: YourBank[];
		today: string;
		polls?: boolean;
		/** Poll while Tally sorts too, within the hour (decision 146). */
		keepPolling?: boolean;
	};
	focusStatus?: boolean;
	/** False draws no presence check-in: a drawing (the catalog, the proposals) fires nothing by itself (decision 146). */
	polls?: boolean;
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
	const { phase } = view;
	const before = phase === "before";
	return (
		<section id="setup-top" class="mt-2" aria-labelledby="setup-title">
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
					tabindex={focusStatus && before ? -1 : undefined}
					autofocus={focusStatus && before}
				>
					{before ? BEFORE_HEADLINE : "Your first week"}
				</h1>
				<Notebook strokes={view.drawn} ink size="size-24" />
			</div>
			{phase !== "before" && (
				<p
					id="setup-status"
					tabindex={-1}
					data-link-bank-focus
					{...(focusStatus ? { autofocus: true } : {})}
					class="mt-3 font-serif text-lg italic"
				>
					{statusOf(view, Boolean(bankLine))}
				</p>
			)}
			{phase === "ready" && (
				<div class="mt-4">
					<Band
						href="/first-page"
						detail="Your pay, your bills and your budgets. About three minutes."
					>
						Set up your budget
					</Band>
				</div>
			)}
			{phase === "reading" && (
				<p id="setup-next" class="mt-2 text-muted">
					{setupNextLine(view, Boolean(bankLine))}
				</p>
			)}
			{/* A sibling of #setup-next, #setup-status and Your banks, never inside them: those are swapped or polled (home.tsx). */}
			{phase === "reading" && notify && (
				<NotifyControl
					vapidKey={notify.vapidKey}
					shown={notify.shown}
					idSuffix={notify.idSuffix}
				/>
			)}
			{bankLine && <BankBehind words={bankLine} />}
			{phase === "reading" && yourBanks && (
				<YourBanks
					banks={yourBanks.banks}
					today={yourBanks.today}
					polls={yourBanks.polls}
					keepPolling={yourBanks.keepPolling}
					step={setupStep(view)}
				/>
			)}
			{phase === "reading" && linkBank && (
				<div class="mt-6">
					<h2 class="text-lg font-semibold">Have more accounts?</h2>
					<p class="mt-1 text-muted">
						Link every bank and card you use now, so your first questions cover
						them all.
					</p>
					<div class="mt-3">{linkBank}</div>
				</div>
			)}
			<TallySteps steps={view.steps} />
			{phase === "before" && linkBank && (
				<div class="mt-6">
					{linkBank}
					<p class="mt-3 text-sm text-muted">
						Tally can only read your bank. It can't move money.
					</p>
				</div>
			)}
			{/* The check-in says the person is still here (decision 146), and names the step this page shows, so /home/seen redraws
			    the top once that step has moved on, with no reload. A page that no longer refreshes checks in too. */}
			{polls && (phase === "reading" || phase === "ready") && (
				<HomeSeenCheckIn step={phase === "ready" ? "ready" : setupStep(view)} />
			)}
		</section>
	);
}
