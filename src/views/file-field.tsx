import { FormField } from "./form-field";

type Props = {
	/** The file input's id; its error is `${id}-error`, and FormField names it in aria-describedby. */
	id: string;
	/** The file input's name, as the form posts it. */
	name: string;
	label: string;
	hint?: string;
	error?: string;
	/** The types the picker offers. The server never checks a file's type or name: iPhone Files may send another. */
	accept?: string;
	/** Moves focus here when the sheet opens or redraws with this field's error. */
	autofocus?: boolean;
};

/**
 * A labeled file input (Apple Card's CSV now, receipts' file input later, spec §8.9, §8.10): built on FormField, so the
 * label, hint and error are read in that order. It is not `required`, since a browser's bubble would replace the
 * server's words. Its button is a 44px target, and it takes the page's type and colour tokens only.
 */
export function FileField({
	id,
	name,
	label,
	hint,
	error,
	accept = ".csv,text/csv",
	autofocus,
}: Props) {
	return (
		<FormField id={id} label={label} hint={hint} error={error}>
			{(a11y) => (
				<input
					type="file"
					id={id}
					name={name}
					accept={accept}
					autofocus={autofocus}
					{...a11y}
					class={`${a11y.class ?? ""} min-h-11 w-full py-2 text-base text-ink file:mr-3 file:min-h-11 file:border file:border-rule file:bg-paper file:px-4 file:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`.trim()}
				/>
			)}
		</FormField>
	);
}
