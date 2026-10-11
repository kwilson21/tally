// What AI did this month (spec §8.6, decisions 73, 79 and 80; P43 A and P77 A): a muted "In October" under
// the AI suggestions switches, three short lines and a Why?. A switched-off feature keeps its line, in muted
// words, so the tally always has the same lines.
import { monthName } from "../dates";
import type { AiTallyCounts } from "../db/ai-log";
import { WhyLink } from "./why-link";

/** The switches the tally's lines follow. A switched-off feature's line says Off in place of its count. */
export type TallySwitches = {
	names: boolean;
	categories: boolean;
	income: boolean;
};

const count = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** The tally: its month's name, then the lines, each muted when its feature is off. */
export function AiTally({
	tally,
	switches,
}: {
	tally: AiTallyCounts;
	switches: TallySwitches;
}) {
	const sorted = switches.categories
		? `Sorted ${count(tally.sorted, "transaction", "transactions")} · you changed ${tally.changed}`
		: "Transactions · Off";
	const named = switches.names
		? `Cleaned ${count(tally.named, "merchant name", "merchant names")}`
		: "Merchant names · Off";
	const paychecks = switches.income
		? `Found ${count(tally.paychecks, "paycheck", "paychecks")}`
		: "Paychecks · Off";
	return (
		<div class="mt-5">
			<h3 class="text-sm text-muted">In {monthName(tally.month)}</h3>
			<ul class="mt-1">
				<li class={switches.categories ? undefined : "text-muted"}>{sorted}</li>
				<li class={switches.names ? undefined : "text-muted"}>{named}</li>
				<li class={switches.income ? undefined : "text-muted"}>{paychecks}</li>
			</ul>
			<div class="mt-2">
				<WhyLink section="what-ai-did" topic="what Tally did" />
			</div>
		</div>
	);
}
