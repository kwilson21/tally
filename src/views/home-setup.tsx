// Home's top during a new family's first week (P125 E, decision 114, spec §8.8). It replaces HomeTop's headline area
// until setup is done: the notebook with the strokes drawn so far, the five lines, and before a bank the one button.
// The words come from the setup view (src/first-tally/setup.ts); the catalog draws it from fake views.
import type { Child } from "hono/jsx";
import type { SetupView } from "../first-tally/setup";
import { Band } from "./band";
import { Notebook } from "./notebook";
import { TallySteps } from "./tally-steps";

const WORDS = ["None", "One", "Two", "Three", "Four", "Five"];
const count = (n: number) => n.toLocaleString("en-US");

/** The status sentence (serif italic) for the reading and ready states. */
function statusOf(view: SetupView): string {
	if (view.phase === "ready") {
		return `Tally sorted ${count(view.total)} overnight. Three things to check, and Safe to spend is written in at the end.`;
	}
	if (!view.fitsOneNight) {
		return `Tally's sorted ${count(view.sorted)} of ${count(view.total)}. Your questions will be ready when it's done, usually in a night or two.`;
	}
	const drawn = view.drawn > 0 ? `${WORDS[view.drawn] ?? view.drawn}. ` : "";
	return `${drawn}Tally's reading your last 90 days from ${view.bankName ?? "your bank"}. Your questions will usually be ready by the morning.`;
}

/**
 * The setup top. `linkBank` is Home's Link a bank (before a bank, and only when Plaid is on): the one button, with its
 * error region. The status takes focus after Plaid redraws Home (`data-link-bank-focus`, plaid-link.js).
 */
export function HomeSetup({
	view,
	linkBank,
}: {
	view: SetupView;
	linkBank?: Child;
}) {
	const { phase } = view;
	return (
		<section class="mt-2" aria-labelledby="setup-title">
			<div class="flex items-center justify-between gap-4">
				<h1
					id="setup-title"
					class="min-w-0 font-serif text-4xl font-semibold tracking-tight"
				>
					{phase === "before"
						? "Five strokes, and you're set up."
						: "Your first week"}
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
						{statusOf(view)}
					</p>
					{phase === "reading" && (
						<p class="mt-2 text-muted">Nothing for you to do until then.</p>
					)}
				</>
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
