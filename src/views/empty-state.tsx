import type { Child } from "hono/jsx";
import { Button } from "./button";

export type EmptyStateProps = {
	/** The accent mark: a magnifier (no results), a tick (nothing to do) or an add sign (one thing to start, decision 55). */
	kind: "search" | "done" | "add";
	sentence: string;
	hint?: string;
	action?: { href: string; label: string };
	/** The screen's own action when it isn't a link, such as Accounts' script-driven Link a bank (decision 55). */
	children?: Child;
};

/**
 * A finished empty list: a decorative notebook drawing, an explanation, and at most one action: a
 * secondary link, or the screen's own control passed as children (decision 55).
 */
export function EmptyState({
	kind,
	sentence,
	hint,
	action,
	children,
}: EmptyStateProps) {
	return (
		<div class="flex flex-col items-center py-8 text-center">
			<svg
				class="size-16 shrink-0"
				viewBox="0 0 64 64"
				fill="none"
				stroke-width="1.75"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<g class="stroke-ink">
					<rect x="12" y="8" width="34" height="46" rx="3" />
					<line x1="19" y1="20" x2="39" y2="20" />
					<line x1="19" y1="28" x2="39" y2="28" />
					<line x1="19" y1="36" x2="31" y2="36" />
				</g>
				{kind === "search" && (
					<g class="stroke-accent fill-paper">
						<circle cx="44" cy="42" r="9" />
						<line x1="50.5" y1="48.5" x2="57" y2="55" />
					</g>
				)}
				{kind === "done" && (
					<path class="stroke-accent" d="M36 44 L42 50 L55 35" />
				)}
				{kind === "add" && (
					<g class="stroke-accent fill-paper">
						<circle cx="45" cy="44" r="10" />
						<line x1="45" y1="39" x2="45" y2="49" />
						<line x1="40" y1="44" x2="50" y2="44" />
					</g>
				)}
			</svg>
			<p class="mt-3 text-lg">{sentence}</p>
			{hint && <p class="mt-1 max-w-xs text-muted">{hint}</p>}
			{action && (
				<div class="mt-4">
					<Button kind="secondary" href={action.href}>
						{action.label}
					</Button>
				</div>
			)}
			{children && <div class="mt-6">{children}</div>}
		</div>
	);
}
