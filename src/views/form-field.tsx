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
	children: (a11y: FieldA11y) => Child;
};

/** The attributes that link a control to its error; each is set only when it applies. */
type FieldA11y = {
	"aria-describedby"?: string;
	"aria-invalid"?: "true";
	class?: "field-shake";
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

	const a11y: FieldA11y = {};

	if (describedBy) a11y["aria-describedby"] = describedBy;

	if (error) {
		a11y["aria-invalid"] = "true";
		a11y.class = "field-shake";
	}

	return (
		<div class="flex flex-col gap-1">
			<label for={id} class={hideLabel ? "sr-only" : "text-base text-ink"}>
				{label}
			</label>
			{children(a11y)}
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
