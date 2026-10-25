// Setup's step bar (P142 A, decision 148, spec §8.8): where setup is, in words, over four short segments, one inked for each
// step done and the next one half inked. The words say it; the segments are hidden from assistive technology. Drawn from the
// proposals' own StepBar (proposals-setup.tsx), so the picked look is the one the app draws.

/** The reading screen's step bar label (step one of four, Reading your bank). */
export const READING_STEP = "Step 1 of 4 done · Reading your bank";

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
