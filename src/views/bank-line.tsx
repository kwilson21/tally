import { Button } from "./button";
import { Icon, type IconName } from "./icons";

/**
 * Banks' sync issues in the picked Home treatment, before the spending forecast. Apple Card's reminder uses the same line
 * with the card icon and an Upload link (decision 138); the other props default to the bank's Fix.
 */
export function BankBehind({
	words,
	icon = "bank",
	label = "Fix",
	srLabel = " the bank in Accounts",
	href = "/accounts",
}: {
	words: string[];
	/** The line's icon, the bank's by default. */
	icon?: IconName;
	/** The button's text, Fix by default. */
	label?: string;
	/** What a screen reader adds to the button's text (its leading space included). */
	srLabel?: string;
	/** Where the button goes, Accounts by default. */
	href?: string;
}) {
	const lines =
		words.length === 1 ? (
			<p class="min-w-0 flex-1 text-pretty">{words[0]}</p>
		) : (
			<ul class="min-w-0 flex-1 list-none space-y-1 text-pretty">
				{words.map((word) => (
					<li>{word}</li>
				))}
			</ul>
		);
	return (
		<div class="mt-3 flex items-center gap-3 rounded-control border border-over/20 bg-over/10 py-2 pr-2 pl-3">
			<span class="shrink-0 text-over">
				<Icon name={icon} class="size-6" />
			</span>
			{lines}
			<Button href={href} kind="secondary" class="shrink-0 px-4">
				{label}
				<span class="sr-only">{srLabel}</span>
			</Button>
		</div>
	);
}
