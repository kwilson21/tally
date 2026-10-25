// The welcome, setup's first screen before a bank (P142 A, decision 148, spec §8.8): what Tally does, the four steps with what
// each is for and how long it takes, then Link your bank at the screen's foot with the line that Tally can only read the bank.
// The words are the picked drawing's (proposals-setup.tsx's WelcomeBody and WelcomeActions). In the family app only, until a
// bank is linked; the caller passes Plaid's button as `linkBank`, and none when Plaid is off.
import type { Child } from "hono/jsx";
import { Notebook } from "./notebook";
import { SetupScreen } from "./setup-screen";

export const WELCOME_HEADING = "Welcome to Tally.";

/** The four steps, each with what it's for and how long it takes (decision 148's words). */
export const WELCOME_STEPS = [
	{
		name: "Link your bank",
		benefit: "Tally reads your last 90 days, so you don't start from zero.",
		note: "About a minute",
	},
	{
		name: "Your pay",
		benefit: "So Tally knows what comes in.",
		note: "One question",
	},
	{
		name: "Your bills",
		benefit: "So they're set aside before you spend.",
		note: "One question",
	},
	{
		name: "Your budgets",
		benefit: "Suggested from what you really spend.",
		note: "One tap",
	},
] as const;

/**
 * The welcome. `linkBank` is the one button at the foot (Plaid's, in the app; a plain button in a drawing). `focusHeading` makes
 * the heading take focus, for a redraw that lands on this screen (part 2 of #772); a full load never sets it.
 */
export function SetupWelcome({
	linkBank,
	focusHeading = false,
}: {
	linkBank?: Child;
	focusHeading?: boolean;
}) {
	return (
		<SetupScreen
			foot={
				<>
					{linkBank}
					<p class="mt-3 text-center text-sm text-muted">
						Tally can only read your bank. It can't move money.
					</p>
				</>
			}
		>
			<Notebook strokes={0} ink size="size-16" />
			<h1
				id="setup-title"
				class="mt-2 font-serif text-4xl font-semibold tracking-tight"
				{...(focusHeading ? { tabindex: -1, autofocus: true } : {})}
			>
				{WELCOME_HEADING}
			</h1>
			<p class="mt-3 text-lg">
				Tally reads your bank, sorts your spending and shows what's safe to
				spend this month.
			</p>
			<p class="mt-2 text-muted">Four steps, about four minutes of your time.</p>
			<ol class="mt-6 border-t border-rule">
				{WELCOME_STEPS.map((step, i) => (
					<li class="flex items-start gap-3 border-b border-rule py-3">
						<span class="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-rule text-sm tabular-nums text-muted">
							{i + 1}
						</span>
						<div class="min-w-0 flex-1">
							<p class="font-medium">{step.name}</p>
							<p class="text-sm text-muted">{step.benefit}</p>
						</div>
						<p class="shrink-0 pt-0.5 text-sm text-muted">{step.note}</p>
					</li>
				))}
			</ol>
		</SetupScreen>
	);
}
