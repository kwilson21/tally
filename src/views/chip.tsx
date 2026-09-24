import type { Child } from "hono/jsx";

type Props = {
	type: "checkbox" | "radio";
	name: string;
	value: string;
	checked?: boolean;
	icon?: Child;
	children?: Child;
};

/** A pill-shaped checkbox or radio: the real input is visually hidden but keyboard-reachable; the pill shows its state. */
export function Chip({ type, name, value, checked, icon, children }: Props) {
	return (
		<label class="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-rule px-4 text-base text-ink has-[:checked]:border-ink has-[:checked]:bg-band has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
			<input
				type={type}
				name={name}
				value={value}
				checked={checked}
				class="sr-only"
			/>
			{icon}
			{children}
		</label>
	);
}
