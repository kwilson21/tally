import { Hono } from "hono";
import { accountsByBank, netWorthCents } from "../db/accounts";
import { AccountsTop } from "../views/accounts-top";
import { BankGroup } from "../views/bank-group";
import { Layout } from "../views/layout";

type App = { Bindings: Env };
export const accounts = new Hono<App>();

// More → Accounts (spec §8): net worth, then each linked bank's accounts. Link a bank comes with #16, Fix connection with #21.
accounts.get("/accounts", async (c) => {
	const banks = await accountsByBank(c.env.DB);
	return c.html(
		<Layout
			title="Accounts · Tally"
			active="accounts"
			demo={c.env.DEMO === "true"}
		>
			<AccountsTop
				netWorthCents={netWorthCents(banks.flatMap((b) => b.accounts))}
			/>
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
		</Layout>,
	);
});
