type Props = {
	/** Ties the select to its label; unique on the page. */
	id: string;
	/** The form field the choice posts under (and the URL parameter, on Transactions). */
	name: string;
	/** What it chooses, in the person's words ("Month"). Read by a screen reader, not shown. */
	label: string;
	options: { value: string | number; label: string }[];
	/** The chosen option's value; null when none is, so the first option shows. */
	selected: string | number | null;
};

/**
 * A pill-shaped choice among a few options, for narrowing a list (Month, Category, Account and Show on
 * Transactions): a real select, named by a label only a screen reader hears, with the chosen option
 * showing in the pill. max-w-full lets a long option shorten inside its pill rather than push the page
 * sideways.
 */
export function FilterSelect({ id, name, label, options, selected }: Props) {
	return (
		<>
			<label for={id} class="sr-only">
				{label}
			</label>
			<select
				id={id}
				name={name}
				class="min-h-11 max-w-full rounded-full border border-rule bg-paper px-4 text-base text-ink"
			>
				{options.map((o) => (
					<option
						value={o.value}
						selected={selected !== null && String(selected) === String(o.value)}
					>
						{o.label}
					</option>
				))}
			</select>
		</>
	);
}
