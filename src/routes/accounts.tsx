import { Hono } from "hono";
import { accountsByBank, netWorthCents } from "../db/accounts";
import { AccountsTop } from "../views/accounts-top";
import { BankGroup } from "../views/bank-group";
import { Button } from "../views/button";
import { Layout } from "../views/layout";
import { enabled } from "./plaid";

type App = { Bindings: Env };
export const accounts = new Hono<App>();

// More → Accounts (spec §8): net worth, each linked bank, then the Plaid Link action when configured.
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
					? [
							"https://cdn.plaid.com/link/v2/stable/link-initialize.js",
							"/js/plaid-link.js",
						]
					: []
			}
		>
			<AccountsTop
				netWorthCents={netWorthCents(banks.flatMap((b) => b.accounts))}
			/>
			<div id="accounts-banks">
				{banks.length === 0 ? (
					<p class="mt-8 text-lg">No banks linked yet.</p>
				) : (
					banks.map((b) => (
						<BankGroup
							name={b.name}
							accounts={b.accounts}
							needsAttention={b.needsAttention}
						/>
					))
				)}
				{plaidEnabled && (
					<>
						<Button
							type="button"
							class="mt-8"
							busyLabel="Linking…"
							data-link-bank
						>
							Link a bank
						</Button>
						<div data-link-bank-error class="mt-3" />
					</>
				)}
			</div>
		</Layout>,
	);
});
