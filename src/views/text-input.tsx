import type { JSX } from "hono/jsx";
import { FormField } from "./form-field";

type Props = Omit<JSX.IntrinsicElements["input"], "class"> & {
	id: string;
	label: string;
	hint?: string;
	error?: string;
	surface?: "band" | "paper";
	class?: string;
};

/** A labeled single-line text field with an accessible error. */
export function TextInput({
	id,
	label,
	hint,
	error,
	surface = "band",
	class: layout,
	...attrs
}: Props) {
	return (
		<FormField id={id} label={label} hint={hint} error={error}>
			{({ class: errorClass, ...a11y }) => (
				<input
					id={id}
					class={`min-h-11 rounded-control border border-rule ${surface === "paper" ? "bg-paper" : "bg-band"} px-3 text-lg disabled:opacity-40${errorClass ? ` ${errorClass}` : ""}${layout ? ` ${layout}` : ""}`}
					{...attrs}
					{...a11y}
				/>
			)}
		</FormField>
	);
}
