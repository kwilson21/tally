import type { Child } from "hono/jsx";
import { Icon } from "./icons";

type Props = {
	type: "checkbox" | "radio";
	name: string;
	value: string;
	checked?: boolean;
	/** On one radio of a group, makes choosing one of them required. */
	required?: boolean;
	autofocus?: boolean;
	/** The id of a hint that explains this choice (aria-describedby). */
	describedBy?: string;
	icon?: Child;
	children?: Child;
	"hx-get"?: string;
	"hx-include"?: string;
	"hx-target"?: string;
	"hx-swap"?: string;
};

/** A pill-shaped checkbox or radio: the real input is visually hidden but keyboard-reachable; the pill shows its state. */
export function Chip({
	type,
	name,
	value,
	checked,
	describedBy,
	icon,
	children,
	...inputAttrs
}: Props) {
	return (
		<label class="group inline-flex min-h-11 min-w-0 max-w-full cursor-pointer items-center gap-2 whitespace-normal rounded-full border border-rule px-4 text-base text-ink wrap-anywhere has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-40 has-[:checked]:border-ink has-[:checked]:bg-band has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
			<input
				type={type}
				name={name}
				value={value}
				checked={checked}
				aria-describedby={describedBy}
				class="sr-only"
				{...inputAttrs}
			/>
			{/* A switched-on toggle also shows a check mark, so its state isn't color alone (DESIGN.md). */}
			{type === "checkbox" && (
				<span class="hidden group-has-[:checked]:inline-flex">
					<Icon name="check" class="size-4" />
				</span>
			)}
			{icon}
			{children}
		</label>
	);
}
