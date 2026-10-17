// The five strokes of a new family's first week as a list, under the notebook (P125 E, decision 114). Each line's glyph is
// its stroke: a short vertical for the first four, a slash for the fifth, in ink when done and dashed muted when not.
// The words carry the state: a done line says "done" to a screen reader, and the note at the right says what was done
// or when it comes.

/**
 * One line of the list: its name, its note, and whether its stroke is drawn. `reAsk` is the line under step one when a bank
 * linked during setup took the questions back (#714): its own full-width muted line, not the note column's.
 */
export type StepLine = {
	name: string;
	done: boolean;
	note: string;
	reAsk?: string;
};

/** The lines in order: `notes` gives each its note, and the first `done` of them are done. */
export function stepsOf(
	names: readonly string[],
	notes: readonly string[],
	done: number,
): StepLine[] {
	return names.map((name, i) => ({
		name,
		done: i < done,
		note: notes[i] ?? "",
	}));
}

/** The five lines, with "Your first tally · N of 5" over them. */
export function TallySteps({ steps }: { steps: StepLine[] }) {
	const done = steps.filter((s) => s.done).length;
	return (
		<div class="mt-4">
			<p class="text-sm text-muted">Your first tally · {done} of 5</p>
			<ul class="mt-2 border-t border-rule">
				{steps.map((s, i) => (
					<li class="flex min-h-11 flex-wrap items-center gap-3 border-b border-rule">
						<svg
							class="h-6 w-3 shrink-0"
							viewBox="0 0 12 24"
							fill="none"
							stroke-width="2"
							stroke-linecap="round"
							aria-hidden="true"
						>
							{i < 4 ? (
								<line
									x1="6"
									y1="2"
									x2="6"
									y2="22"
									class={s.done ? "stroke-ink" : "stroke-muted"}
									stroke-dasharray={s.done ? undefined : "3 3"}
								/>
							) : (
								<line
									x1="1"
									y1="22"
									x2="11"
									y2="2"
									class={s.done ? "stroke-ink" : "stroke-muted"}
									stroke-dasharray={s.done ? undefined : "3 3"}
								/>
							)}
						</svg>
						<span
							class={`min-w-0 flex-1 py-2 text-base ${s.done ? "text-ink" : "text-muted"}`}
						>
							{s.name}
							{s.done && <span class="sr-only">, done</span>}
						</span>
						<span class="shrink-0 text-sm text-muted">{s.note}</span>
						{s.reAsk && (
							<p class="basis-full pb-2 text-sm text-muted">{s.reAsk}</p>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
