type Props = {
	/** The control's id: the label is tied to it, and the hint and error get `${id}-hint` and `${id}-error`. */
	id: string;
	name: string;
	label: string;
	value: string;
	/** The label stays for screen readers only (the row above it already says it). */
	hideLabel?: boolean;
	hint?: string;
	error?: string;
	/** The amount: serif 4xl, tabular, at least 56px tall. The one big thing on its sheet. */
	big?: boolean;
	/** "$" before the text, hidden from screen readers (the label already says it's an amount). */
	prefix?: string;
	type?: "text" | "date";
	inputmode?: "decimal";
	max?: string;
	autofocus?: boolean;
	required?: boolean;
};

/**
 * A ledger-line field: a small muted label above, then the text on a bottom rule with no box. The
 * rule is `muted`, not the pale `rule`, because it marks where to type (a 3:1 edge); `rule` stays
 * for lines that only separate. Focus draws the accent ring around the line. An error turns the
 * line brick, shakes the field once, and says why under it in role="alert", in words, as FormField
 * does. Without JavaScript it is a plain field in a form that posts.
 */
export function LedgerField({
	id,
	name,
	label,
	value,
	hideLabel,
	hint,
	error,
	big,
	prefix,
	type = "text",
	inputmode,
	max,
	autofocus,
	required,
}: Props) {
	const describedBy =
		[hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
		undefined;
	return (
		<div class="flex flex-col gap-1">
			<label for={id} class={hideLabel ? "sr-only" : "text-sm text-muted"}>
				{label}
			</label>
			<div
				class={`flex items-baseline gap-2 border-b ${error ? "border-over" : "border-muted"} has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent`}
			>
				{prefix && (
					<span
						aria-hidden="true"
						class={
							big ? "font-serif text-4xl text-muted" : "text-lg text-muted"
						}
					>
						{prefix}
					</span>
				)}
				<input
					id={id}
					name={name}
					type={type}
					value={value}
					max={max}
					inputmode={inputmode}
					autocomplete="off"
					autofocus={autofocus}
					required={required}
					aria-invalid={error ? "true" : undefined}
					aria-describedby={describedBy}
					class={`min-w-0 flex-1 bg-transparent focus-visible:outline-none ${big ? "min-h-14 font-serif text-4xl font-semibold tabular-nums" : "min-h-11 text-lg"} ${error ? "field-shake" : ""}`}
				/>
			</div>
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
