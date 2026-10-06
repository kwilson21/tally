type Props = {
	/** Ties the switch to its words and its muted line; unique on the page. */
	id: string;
	/** The form field: a switch that's on posts its `value` ("on"), one that's off posts nothing. */
	name: string;
	/** What it turns on, in the person's words. */
	label: string;
	/** One muted line saying what it does. */
	hint?: string;
	checked?: boolean;
	/**
	 * Greyed out (P86 A, decision 79): it can't be changed, still shows its saved setting, On or Off, in
	 * muted tones, and posts nothing, so the form's Save has to leave its saved setting as it was.
	 */
	disabled?: boolean;
	/** With `disabled`, what it needs, in words, so the greying never rests on color alone. */
	note?: string;
};

/**
 * A real checkbox drawn as a switch (P41 B, decision 73): the label, an optional muted line, "On"
 * or "Off" in words, then the track with its knob. The state comes from the checkbox alone, so it
 * works without a script, and the whole 44px row is the target. A screen reader hears a switch
 * named by the label and described by the line; the words and the track are for the eye. Disabled,
 * the label and the word go muted, the track keeps only a rule-coloured edge and a muted knob, and
 * `note` says what the switch needs; the row is no longer a pointer target. The knob slides and the
 * tones swap in 150 ms (decision 76): `switch-track` and `switch-knob` are classes in app.css, which
 * also shows the end state at once for reduced motion, so no length or reduce class is written here.
 */
export function Switch({
	id,
	name,
	label,
	hint,
	checked,
	disabled,
	note,
}: Props) {
	const describedBy = [hint && `${id}-hint`, disabled && note && `${id}-note`]
		.filter(Boolean)
		.join(" ");
	return (
		<label
			class={`group flex min-h-11 items-center gap-3 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
		>
			<input
				type="checkbox"
				// A native checkbox with role="switch" reads its on/off state from `checked`; an
				// aria-checked would only go stale as the box is toggled without a script.
				// biome-ignore lint/a11y/useAriaPropsForRole: see above
				role="switch"
				id={id}
				name={name}
				value="on"
				checked={checked}
				disabled={disabled}
				aria-labelledby={`${id}-label`}
				aria-describedby={describedBy || undefined}
				class="sr-only"
			/>
			<span class="min-w-0 flex-1">
				<span
					id={`${id}-label`}
					class={`block text-lg ${disabled ? "text-muted" : ""}`}
				>
					{label}
				</span>
				{hint && (
					<span id={`${id}-hint`} class="block text-pretty text-muted">
						{hint}
					</span>
				)}
				{disabled && note && (
					<span
						id={`${id}-note`}
						class="mt-1 block text-pretty text-sm font-medium text-muted"
					>
						{note}
					</span>
				)}
			</span>
			<span
				aria-hidden="true"
				class={`w-8 shrink-0 text-right font-medium ${disabled ? "text-muted" : ""}`}
			>
				<span class="hidden group-has-[:checked]:inline">On</span>
				<span class="group-has-[:checked]:hidden">Off</span>
			</span>
			<span
				aria-hidden="true"
				class={`switch-track flex h-7 w-12 shrink-0 items-center rounded-full border bg-rule px-0.5 ${disabled ? "border-rule" : "border-ink group-has-[:checked]:bg-ink"}`}
			>
				<span
					class={`switch-knob size-5 rounded-full group-has-[:checked]:translate-x-[1.375rem] ${disabled ? "bg-muted" : "bg-ink group-has-[:checked]:bg-paper"}`}
				/>
			</span>
		</label>
	);
}
