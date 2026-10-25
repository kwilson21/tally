// The reading screen (P142 A, decisions 146, 148 and 150, spec §8.8): from a bank linked until the questions open. It says where
// Tally is (reading, sorting with its bar, taking longer than usual, or waiting for the daily run when Sort right away is off),
// what comes next, Notify me on this device, Your banks, the email line until the email has reached someone, and Link another
// bank at the foot. The words are the picked drawing's (proposals-setup.tsx's ReadingBody); the statuses are today's
// statusOf words (home-setup.tsx) plus the daily run's. The page checks in and refreshes in the app; a drawing passes polls false.
import type { Child } from "hono/jsx";
import type { SetupView } from "../first-tally/setup";
import type { YourBank } from "../first-tally/your-banks";
import { BankBehind } from "./bank-line";
import { HomeSeenCheckIn } from "./home-seen";
import { NotifyControl, type NotifyShown } from "./notify-control";
import { SetupScreen } from "./setup-screen";
import { READING_STEP, StepBar } from "./step-bar";
import { YourBanks } from "./your-banks";

export const READING_HEADING = "Reading your bank";
export const EMAIL_LINE =
	"You can close this page. Tally emails you the moment your questions are ready.";
export const MORE_BANKS_LINE =
	"Link every bank and card you use, so your questions cover them all.";

/** The email line, drawn only until the ready email has reached someone. Its region (#setup-email) is always drawn. */
export function EmailLine({ emailed }: { emailed: boolean }) {
	return emailed ? null : (
		<p class="mt-6 rounded-control bg-band p-4">{EMAIL_LINE}</p>
	);
}

const count = (n: number) => n.toLocaleString("en-US");

/** The step the reading screen shows: the daily run's wait, slow, sorting, else reading. A poll and the check-in name it. */
export function readingStep(
	view: SetupView,
): "reading" | "sorting" | "slow" | "run" {
	if (view.waitsForRun) return "run";
	if (view.slow) return "slow";
	if (view.sorting) return "sorting";
	return "reading";
}

/** The status sentence (text-lg), by step. */
export function readingStatus(view: SetupView): string {
	const step = readingStep(view);
	if (step === "run")
		return `Tally sorts your last 90 days in its daily run, at about ${view.runTime}, as set in Settings.`;
	if (step === "slow")
		return `Sorting is taking longer than usual: ${count(view.sorted)} of ${count(view.total)}.`;
	if (step === "sorting")
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
 * The line under the status (muted): what comes next, and whether the page updates as it goes. Only the sorting and reading
 * steps say the page updates, and only while it refreshes. "Nothing for you to do." is left out with a bank line (its Fix).
 */
export function readingNextLine(view: SetupView, bankLine: boolean): string {
	const step = readingStep(view);
	if (step === "run") return "Your three questions open once they're sorted.";
	if (step === "slow")
		return `Tally keeps trying on its own.${bankLine ? "" : " Nothing for you to do."}`;
	const updates = view.refreshes ? " This page updates as it goes." : "";
	if (step === "sorting")
		return `Your three questions open the moment it's done, usually in a few minutes.${updates}`;
	return `Next it sorts them, then you answer three quick questions and your budget is ready.${updates}`;
}

/** The sort's bar, filled to the share sorted, one decimal, 0 to 100; 0 with nothing to sort. */
export function sortedShare(sorted: number, total: number): number {
	if (total <= 0) return 0;
	return Math.min(100, Math.max(0, Math.round((sorted / total) * 1000) / 10));
}

/**
 * The sort's bar, under the status while Tally sorts (and while it takes longer than usual). Hidden from assistive technology:
 * the status says the count, so the bar is only the picture of it.
 */
export function SortBar({ sorted, total }: { sorted: number; total: number }) {
	return (
		<svg class="mt-3 block h-2 w-full" aria-hidden="true">
			<rect width="100%" height="100%" rx="4" class="fill-rule" />
			<rect
				width={`${sortedShare(sorted, total)}%`}
				height="100%"
				rx="4"
				class="fill-ink"
			/>
		</svg>
	);
}

/**
 * The screen. `bankLine` is a connected bank that stopped syncing or needs signing in (src/stale-bank.ts), with its Fix
 * (BankBehind). `yourBanks` are the connected banks' rows (YourBanks). `notify` is Notify me on this device (decision 149),
 * given when the server has Web Push keys; `shown` and `idSuffix` are for drawings. `linkBank` is the foot's Link another
 * bank (Plaid's button in the app). `focusStatus` makes the status take focus, for a redraw that moved the screen on.
 * `polls` false draws no presence check-in, so a drawing fires nothing by itself (decision 146).
 */
export function SetupReading({
	view,
	bankLine,
	yourBanks,
	notify,
	linkBank,
	focusStatus = false,
	polls = true,
}: {
	view: SetupView;
	bankLine?: string[];
	yourBanks?: {
		banks: YourBank[];
		today: string;
		polls?: boolean;
		keepPolling?: boolean;
	};
	notify?: { vapidKey: string; shown?: NotifyShown; idSuffix?: string };
	linkBank?: Child;
	focusStatus?: boolean;
	polls?: boolean;
}) {
	const step = readingStep(view);
	return (
		<SetupScreen
			foot={
				<>
					{linkBank}
					<p class="mt-3 text-center text-sm text-muted">{MORE_BANKS_LINE}</p>
				</>
			}
		>
			<StepBar done={1} label={READING_STEP} />
			<h1
				id="setup-title"
				class="mt-6 font-serif text-4xl font-semibold tracking-tight"
			>
				{READING_HEADING}
			</h1>
			<p
				id="setup-status"
				class="mt-3 text-lg"
				tabindex={-1}
				data-link-bank-focus
				{...(focusStatus ? { autofocus: true } : {})}
			>
				{readingStatus(view)}
			</p>
			{/* Always drawn, empty when there is no bar, so a refresh can swap what is inside it. */}
			<div id="setup-progress">
				{(step === "sorting" || step === "slow") && (
					<SortBar sorted={view.sorted} total={view.total} />
				)}
			</div>
			<p id="setup-next" class="mt-3 text-muted">
				{readingNextLine(view, Boolean(bankLine))}
			</p>
			{notify && (
				<NotifyControl
					vapidKey={notify.vapidKey}
					shown={notify.shown}
					idSuffix={notify.idSuffix}
				/>
			)}
			{bankLine && <BankBehind words={bankLine} />}
			{yourBanks && (
				<YourBanks
					banks={yourBanks.banks}
					today={yourBanks.today}
					polls={yourBanks.polls}
					keepPolling={yourBanks.keepPolling}
					step={step}
				/>
			)}
			{/* Always drawn, empty once the email has reached someone, so a refresh can take the line away. */}
			<div id="setup-email">
				<EmailLine emailed={view.emailed} />
			</div>
			{polls && <HomeSeenCheckIn step={step} />}
		</SetupScreen>
	);
}
