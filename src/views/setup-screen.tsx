// A setup screen (P142 A, decision 148): its body, then its foot, the screen's actions. On a phone the foot is pinned to the
// screen's foot (sticky), on paper with a rule over it, so the one action is always in reach; from lg it sits under the body.
// /setup swaps the whole screen (#setup-screen) when it moves on, so a linked bank redraws it in place.
import type { Child } from "hono/jsx";

export function SetupScreen({
	children,
	foot,
}: {
	children?: Child;
	foot?: Child;
}) {
	return (
		<div id="setup-screen" class="max-lg:flex max-lg:flex-1 max-lg:flex-col">
			<div class="max-lg:flex-1">{children}</div>
			{foot && (
				<div
					id="setup-foot"
					class="sticky bottom-0 -mx-5 mt-8 border-t border-rule bg-paper px-5 pt-4 pb-[calc(1.5rem+var(--safe-area-bottom))] lg:static lg:mx-0 lg:border-t-0 lg:bg-transparent lg:px-0 lg:pt-0 lg:pb-0"
				>
					{foot}
				</div>
			)}
		</div>
	);
}
