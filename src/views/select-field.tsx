import type { JSX } from "hono/jsx";
import { Icon } from "./icons";

type Props = Omit<JSX.IntrinsicElements["select"], "class"> & {
	/**
	 * pill: a choice that narrows a list (FilterSelect); control: a bordered form field; ledger: a bottom rule on a
	 * sentence's line (DueRow's pickers).
	 */
	variant?: "pill" | "control" | "ledger";
	/** A dashed border, for a choice Tally guessed (split-form's category). */
	dashed?: boolean;
	/** A class on the wrapper, so a CSS rule that shows or hides this picker takes its arrow with it (DueRow). */
	wrapClass?: string;
	class?: string;
};

// The text's left padding is the arrow's right inset, so the arrow sits in line with the text's own edge (DESIGN.md).
const VARIANT = {
	pill: {
		box: "rounded-full border border-rule bg-paper pl-4 pr-10 text-base text-ink",
		arrow: "right-4",
	},
	control: {
		box: "rounded-control border border-rule bg-paper pl-3 pr-10 text-base text-ink",
		arrow: "right-3",
	},
	ledger: {
		box: "border-b border-muted bg-transparent pl-1 pr-8 text-lg",
		arrow: "right-1",
	},
} as const;

/**
 * A native select with our own arrow (DESIGN.md: no native select arrows). The browser's arrow sits off-centre in a
 * pill, so the select is `appearance-none` and a chevron is drawn centred vertically at the text's inset. The real
 * select keeps its keyboard, focus and screen-reader behaviour; the chevron is hidden from assistive technology and
 * takes no clicks. A long choice truncates inside the field (max-w-full), so it never pushes the page sideways.
 */
export function SelectField({
	variant = "control",
	dashed = false,
	wrapClass,
	class: extra,
	...attrs
}: Props) {
	const shape = VARIANT[variant];
	const border = dashed ? "border-dashed border-ink" : "";
	return (
		<span
			data-select-field=""
			class={`relative inline-flex max-w-full min-w-0 ${wrapClass ?? ""}`}
		>
			<select
				{...attrs}
				class={[
					"min-h-11 w-full max-w-full appearance-none truncate",
					shape.box,
					border,
					extra,
				]
					.filter(Boolean)
					.join(" ")}
			/>
			<Icon
				name="chevron"
				class={`pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 rotate-90 text-muted ${shape.arrow}`}
			/>
		</span>
	);
}
