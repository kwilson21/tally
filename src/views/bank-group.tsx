import { AccountRow } from "./account-row";
import { Button } from "./button";
import { Icon } from "./icons";

type Account = Parameters<typeof AccountRow>[0] & { id: number };

type Props = {
	/** The bank's name, as Plaid gives it. */
	name: string;
	accounts: Account[];
	/** The bank's login needs fixing (`plaid_items.status = needs_attention`). */
	needsAttention?: boolean;
	/** Extra attributes for the Fix connection button (what opens Plaid Link, #21). */
	fixAttrs?: Record<string, string>;
};

/**
 * One linked bank: its name, its accounts, and, when its login needs fixing, the reason in words with
 * an alert icon (status is never color alone) and a Fix connection button.
 */
export function BankGroup({ name, accounts, needsAttention, fixAttrs }: Props) {
	return (
		<section class="mt-8">
			<h2 class="text-muted">{name}</h2>
			<ul class="mt-2 divide-y divide-rule border-y border-rule">
				{accounts.map(({ id: _, ...account }) => (
					<AccountRow {...account} />
				))}
			</ul>
			{needsAttention && (
				<>
					<p class="mt-3 flex items-center gap-2 text-over">
						<Icon name="alert" class="size-5 shrink-0" />
						Needs attention: sign in again
					</p>
					<Button kind="secondary" type="button" class="mt-3" {...fixAttrs}>
						Fix connection
					</Button>
				</>
			)}
		</section>
	);
}
