// Setup's finish (P142 A, decision 148, spec §8.8, #774): the step bar full, "You're set up.", the month's Safe to spend, what each
// step set up as ruled rows, and Go to Home at the foot. It is drawn as proposals-setup.tsx's DoneBody and DoneActions draw it,
// with the words from first-tally/finish.ts. It changes no route and adds no ids of its own.
import {
	FINISH_HEADING,
	finishLead,
	SORTS_LINE,
	safeToSpendIn,
} from "../first-tally/finish";
import { Button } from "./button";
import { headlineAmountClass } from "./headline-amount";
import { safeToSpendText } from "./home-top";
import { Notebook } from "./notebook";
import { Heading } from "./setup-questions";
import { SetupScreen } from "./setup-screen";
import { FINISH_STEP, StepBar } from "./step-bar";

/** What each step set up, already worded (finish.ts). A step that set nothing is null, or an empty list for Pay. */
export type FinishRows = {
	/** One value per merchant the family said yes to. */
	pay: string[];
	bills: string | null;
	budgets: string | null;
	savings: string | null;
};

export function SetupFinish({
	month,
	safeCents,
	rows,
	sortsOnArrival,
	focus,
}: {
	/** The household month, "2026-10". */
	month: string;
	/** The month's Safe to spend in integer cents; a negative one keeps its minus sign. */
	safeCents: number;
	rows: FinishRows;
	/** Sort right away is on, so the sort line says Tally sorts new transactions as the bank sends them. */
	sortsOnArrival: boolean;
	/** The heading takes focus, when the screen is drawn by a swap. */
	focus: boolean;
}) {
	const amount = safeToSpendText(safeCents);
	const listed = [
		...(rows.pay.length > 0 ? [{ label: "Pay", values: rows.pay }] : []),
		...(rows.bills !== null ? [{ label: "Bills", values: [rows.bills] }] : []),
		...(rows.budgets !== null
			? [{ label: "Budgets", values: [rows.budgets] }]
			: []),
		...(rows.savings !== null
			? [{ label: "Savings", values: [rows.savings] }]
			: []),
	];
	return (
		<SetupScreen
			foot={
				<>
					<Button href="/" class="w-full">
						Go to Home
					</Button>
					{sortsOnArrival && (
						<p class="mt-3 text-center text-sm text-muted">{SORTS_LINE}</p>
					)}
				</>
			}
		>
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0 flex-1">
					<StepBar done={4} label={FINISH_STEP} />
				</div>
				<Notebook strokes={5} ink size="size-16" />
			</div>
			<Heading focus={focus} top="mt-4">
				{FINISH_HEADING}
			</Heading>
			<p class="mt-4 text-lg text-muted">{safeToSpendIn(month)}</p>
			<p
				class={`whitespace-nowrap font-serif text-6xl font-semibold tracking-tight tabular-nums ${headlineAmountClass(amount)}`}
			>
				{amount}
			</p>
			<p class="mt-2 text-muted">{finishLead(month)}</p>
			{listed.length > 0 && (
				<>
					<h2 class="mt-6 text-sm text-muted">What you set up</h2>
					<dl class="mt-2 border-t border-rule">
						{listed.map((row) => (
							<div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-b border-rule py-2">
								<dt class="col-start-1">{row.label}</dt>
								{row.values.map((value) => (
									<dd class="col-start-2 text-right tabular-nums wrap-break-word">
										{value}
									</dd>
								))}
							</div>
						))}
					</dl>
				</>
			)}
		</SetupScreen>
	);
}
