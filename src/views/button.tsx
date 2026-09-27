import type { Child, JSX } from "hono/jsx";

type Kind = "primary" | "secondary" | "text";

const LOOK: Record<Kind, string> = {
	primary: "min-h-11 rounded-control bg-ink px-5 text-paper",
	secondary:
		"inline-flex min-h-11 items-center justify-center rounded-control border border-ink px-5 text-ink no-underline",
	text: "min-h-11 px-2 text-accent",
};

type Props = Omit<JSX.IntrinsicElements["button"], "class"> & {
	kind?: Kind;
	href?: string;
	class?: string;
	children?: Child;
};

/** The shared primary, secondary, and quiet text action. */
export function Button({
	kind = "primary",
	href,
	class: layout,
	children,
	...attrs
}: Props) {
	const className = `${LOOK[kind]}${layout ? ` ${layout}` : ""}`;
	if (href) {
		return (
			<a href={href} {...attrs} class={className}>
				{children}
			</a>
		);
	}
	return (
		<button {...attrs} class={className}>
			{children}
		</button>
	);
}
