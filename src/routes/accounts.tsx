import { Hono } from "hono";
import { accountsByBank, netWorthCents } from "../db/accounts";
import { AccountsTop } from "../views/accounts-top";
import { BankGroup } from "../views/bank-group";
import { Button } from "../views/button";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import { enabled } from "./plaid";

type App = { Bindings: Env };
export const accounts = new Hono<App>();

/** Link a bank and its alert region. Both live inside #accounts-summary, so a refresh redraws them in place. */
const LinkBank = ({ class: layout }: { class?: string }) => (
	<>
		<Button type="button" class={layout} busyLabel="Linking…" data-link-bank>
			Link a bank
		</Button>
		<div data-link-bank-error class="mt-3" />
	</>
);

// More → Accounts (spec §8): net worth, each linked bank, then the Plaid Link action when configured.
// Before any bank is linked there's nothing to add up, so no $0: the add empty state instead (decision 55).
accounts.get("/accounts", async (c) => {
	const banks = await accountsByBank(c.env.DB);
	const plaidEnabled = enabled(c.env);
	return c.html(
		<Layout
			title="Accounts · Tally"
			active="accounts"
			demo={c.env.DEMO === "true"}
			scripts={
				plaidEnabled
					? ["https://cdn.plaid.com/link/v2/stable/link-initialize.js"]
					: []
			}
			modules={plaidEnabled ? ["/js/plaid-link.js"] : []}
		>
			<div id="accounts-summary">
				{banks.length === 0 ? (
					<>
						<h1 class="font-serif text-5xl font-semibold tracking-tight">
							Accounts
						</h1>
						<div class="mt-16">
							<EmptyState
								kind="add"
								sentence="No banks linked yet."
								hint="Link your bank to see balances and net worth here. Tally can only read them; it can't move money."
							>
								{plaidEnabled && <LinkBank />}
							</EmptyState>
						</div>
					</>
				) : (
					<>
						<AccountsTop
							netWorthCents={netWorthCents(banks.flatMap((b) => b.accounts))}
						/>
						<div id="accounts-banks">
							{banks.map((b) => (
								<BankGroup
									name={b.name}
									accounts={b.accounts}
									needsAttention={b.needsAttention}
									fixAttrs={
										plaidEnabled
											? {
													"data-fix-connection": "",
													"data-item-id": String(b.id),
												}
											: undefined
									}
								/>
							))}
						</div>
						{plaidEnabled && <LinkBank class="mt-8" />}
					</>
				)}
			</div>
		</Layout>,
	);
});
