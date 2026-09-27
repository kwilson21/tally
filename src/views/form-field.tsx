import type { Child } from "hono/jsx";

type Props = {
	/** The control's id; an error gets `${id}-error`, which the control names in aria-describedby. */
	id: string;
	label: string;
	/** Visually hide the label (it's still read by screen readers). */
	hideLabel?: boolean;
	hint?: string;
	error?: string;
	/** Renders the control, given the attributes that link it to its error. */
	children: (a11y: {
		"aria-describedby"?: string;
		"aria-invalid"?: "true";
		class?: "field-shake";
	}) => Child;
};

/** A labeled form control, with its error shown and announced. */
export function FormField({
	id,
	label,
	hideLabel,
	hint,
	error,
	children,
}: Props) {
	const describedBy = [hint && `${id}-hint`, error && `${id}-error`]
		.filter(Boolean)
		.join(" ");
	return (
		<div class="flex flex-col gap-1">
			<label for={id} class={hideLabel ? "sr-only" : "text-base text-ink"}>
				{label}
			</label>
			{children({
				...(describedBy ? { "aria-describedby": describedBy } : {}),
				...(error ? { "aria-invalid": "true" as const } : {}),
				...(error ? { class: "field-shake" as const } : {}),
			})}
			{hint && (
				<p id={`${id}-hint`} class="text-sm text-muted">
					{hint}
				</p>
			)}
			{error && (
				<p id={`${id}-error`} role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
		</div>
	);
}
