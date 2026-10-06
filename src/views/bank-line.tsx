import { Button } from "./button";
import { Icon } from "./icons";

/** A bank's sync issue in the picked Home treatment, before the spending forecast. */
export function BankBehind({ words }: { words: string }) {
	return (
		<div class="mt-3 flex items-center gap-3 rounded-control border border-over/20 bg-over/10 py-2 pr-2 pl-3">
			<span class="shrink-0 text-over">
				<Icon name="bank" class="size-6" />
			</span>
			<p class="min-w-0 flex-1 text-pretty">{words}</p>
			<Button href="/accounts" kind="secondary" class="shrink-0 px-4">
				Fix<span class="sr-only"> the bank in Accounts</span>
			</Button>
		</div>
	);
}
