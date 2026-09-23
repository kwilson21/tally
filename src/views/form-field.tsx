import type { Child } from "hono/jsx";

type Props = {
	/** The control's id; an error gets `${id}-error`, which the control names in aria-describedby. */
	id: string;
	label: string;
	/** Visually hide the label (it's still read by screen readers). */
	hideLabel?: boolean;
	error?: string;
	/** Renders the control, given the attributes that link it to its error. */
	children: (a11y: {
		"aria-describedby"?: string;
		"aria-invalid"?: "true";
	}) => Child;
};

/** A labeled form control, with its error shown and announced. */
export function FormField({ id, label, hideLabel, error, children }: Props) {
	return (
		<div class="flex flex-col gap-1">
			<label for={id} class={hideLabel ? "sr-only" : "text-base text-ink"}>
				{label}
			</label>
			{children(
				error
					? { "aria-describedby": `${id}-error`, "aria-invalid": "true" }
					: {},
			)}
			{error && (
				<p id={`${id}-error`} role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
		</div>
	);
}
