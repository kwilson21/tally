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
};

/**
 * A real checkbox drawn as a switch (P41 B, decision 73): the label, an optional muted line, "On"
 * or "Off" in words, then the track with its knob. The state comes from the checkbox alone, so it
 * works without a script, and the whole 44px row is the target. A screen reader hears a switch
 * named by the label and described by the line; the words and the track are for the eye.
 */
export function Switch({ id, name, label, hint, checked }: Props) {
	return (
		<label class="group flex min-h-11 cursor-pointer items-center gap-3 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
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
				aria-labelledby={`${id}-label`}
				aria-describedby={hint ? `${id}-hint` : undefined}
				class="sr-only"
			/>
			<span class="min-w-0 flex-1">
				<span id={`${id}-label`} class="block text-lg">
					{label}
				</span>
				{hint && (
					<span id={`${id}-hint`} class="block text-pretty text-muted">
						{hint}
					</span>
				)}
			</span>
			<span aria-hidden="true" class="w-8 shrink-0 text-right font-medium">
				<span class="hidden group-has-[:checked]:inline">On</span>
				<span class="group-has-[:checked]:hidden">Off</span>
			</span>
			<span
				aria-hidden="true"
				class="flex h-7 w-12 shrink-0 items-center rounded-full border border-ink bg-rule px-0.5 transition-colors duration-150 group-has-[:checked]:bg-ink motion-reduce:transition-none"
			>
				<span class="size-5 rounded-full bg-ink transition-transform duration-150 group-has-[:checked]:translate-x-[1.375rem] group-has-[:checked]:bg-paper motion-reduce:transition-none" />
			</span>
		</label>
	);
}
