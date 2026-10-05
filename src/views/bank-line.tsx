import { Icon } from "./icons";

/**
 * Home's line for a bank that stopped syncing (decision 72, P37 A): an alert icon (never color alone),
 * the words in ink, since it isn't over budget so it isn't brick, what it means for Safe to spend, and
 * a terracotta link to Accounts. It stands between the status sentence and the Band.
 */
export function BankLine({ words }: { words: string }) {
	return (
		<div class="mt-3 flex items-start gap-2">
			<span class="mt-0.5 shrink-0">
				<Icon name="alert" class="size-5" />
			</span>
			<div>
				<p>{words}</p>
				<a href="/accounts" class="inline-flex min-h-11 items-center">
					Check Accounts
				</a>
			</div>
		</div>
	);
}
