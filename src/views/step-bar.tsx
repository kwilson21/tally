// Setup's step bar (P142 A, decision 148, spec §8.8): where setup is, in words, over four short segments, one inked for each
// step done and the next one half inked. The words say it; the segments are hidden from assistive technology. Drawn from the
// proposals' own StepBar (proposals-setup.tsx), so the picked look is the one the app draws.

/** The reading screen's step bar label (step one of four, Reading your bank). */
export const READING_STEP = "Step 1 of 4 done · Reading your bank";
/** The pay question's step label (step two of four; one step done before it). */
export const PAY_STEP = "Step 2 of 4 · Your pay";
/** The bills question's step label (step three of four; two steps done before it). */
export const BILLS_STEP = "Step 3 of 4 · Your bills";
/** The budgets question's step label (step four of four; three steps done before it, the savings question included). */
export const BUDGETS_STEP = "Step 4 of 4 · Your budgets";
/** The finish's step label (all four steps done, so every segment is inked). */
export const FINISH_STEP = "Setup done";

/** Four segments: the steps done in ink, the next one half inked while setup has steps left, the rest in rule. */
export function StepBar({ done, label }: { done: number; label: string }) {
	const bar = (i: number) =>
		i < done ? "bg-ink" : i === done && done < 4 ? "bg-ink/40" : "bg-rule";
	return (
		<div>
			<p class="text-sm text-muted">{label}</p>
			<div class="mt-2 grid grid-cols-4 gap-1.5" aria-hidden="true">
				{[0, 1, 2, 3].map((i) => (
					<span class={`h-1 rounded-full ${bar(i)}`} />
				))}
			</div>
		</div>
	);
}
