import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import type { NetWorthView } from "../net-worth";
import { NetWorthChart } from "./net-worth-chart";

/**
 * The Accounts screen's top (round 5 study, P25 A): the title, Net worth in whole dollars as the
 * serif headline, and the net-worth chart in the ruled space under it.
 */
export function AccountsTop({
	netWorthCents,
	history,
	action,
}: {
	netWorthCents: number;
	history: NetWorthView;
	action?: Child;
}) {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">Accounts</h1>
			{action}
			<p class="mt-3 text-lg text-muted">Net worth</p>
			<p class="font-serif text-6xl font-semibold tracking-tight lg:text-7xl">
				{formatCents(netWorthCents, { wholeDollars: true })}
			</p>
			<NetWorthChart view={history} />
		</>
	);
}
