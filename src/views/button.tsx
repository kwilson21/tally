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
	busyLabel?: string;
};

function Content({
	children,
	busyLabel,
}: {
	children?: Child;
	busyLabel?: string;
}) {
	if (!busyLabel) return <>{children}</>;
	return (
		<>
			<span class="[.htmx-request_&]:hidden">{children}</span>
			<span class="hidden [.htmx-request_&]:inline-flex items-center gap-2">
				<svg
					class="button-spinner size-4"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="3"
					aria-hidden="true"
				>
					<circle cx="12" cy="12" r="9" opacity="0.25" />
					<path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round" />
				</svg>
				{busyLabel}
			</span>
		</>
	);
}

/** The shared primary, secondary, and quiet text action. */
export function Button({
	kind = "primary",
	href,
	class: layout,
	children,
	busyLabel,
	disabled,
	...attrs
}: Props) {
	const look = layout?.split(/\s+/).some((token) => token.startsWith("px-"))
		? LOOK[kind].replace(/(?:^|\s)px-\S+/, "")
		: LOOK[kind];
	const className = `${look}${layout ? ` ${layout}` : ""}`;
	const buttonClassName = `${className} disabled:opacity-40`;
	if (href && disabled) {
		return (
			<button type="button" disabled {...attrs} class={buttonClassName}>
				<Content busyLabel={busyLabel}>{children}</Content>
			</button>
		);
	}
	if (href) {
		return (
			<a
				href={href}
				{...attrs}
				class={`${className} inline-flex items-center justify-center no-underline`}
			>
				<Content busyLabel={busyLabel}>{children}</Content>
			</a>
		);
	}
	return (
		<button disabled={disabled} {...attrs} class={buttonClassName}>
			<Content busyLabel={busyLabel}>{children}</Content>
		</button>
	);
}
