import { Button } from "./button";

export type EmptyStateProps = {
	kind: "search" | "done";
	sentence: string;
	hint?: string;
	action?: { href: string; label: string };
};

/** A finished empty list: a decorative notebook drawing, an explanation, and at most one action. */
export function EmptyState({ kind, sentence, hint, action }: EmptyStateProps) {
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
				{kind === "search" ? (
					<g class="stroke-accent fill-paper">
						<circle cx="44" cy="42" r="9" />
						<line x1="50.5" y1="48.5" x2="57" y2="55" />
					</g>
				) : (
					<path class="stroke-accent" d="M36 44 L42 50 L55 35" />
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
		</div>
	);
}
