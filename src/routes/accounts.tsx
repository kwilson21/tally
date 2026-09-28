import { Hono } from "hono";
import { accountsByBank, netWorthCents } from "../db/accounts";
import { applyMerchantRules } from "../db/transactions";
import { syncAllItems } from "../plaid/sync-all";
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

const SyncNow = () => (
	<form
		method="post"
		action="/accounts/sync"
		hx-post="/accounts/sync"
		hx-target="#accounts-summary"
		hx-swap="outerHTML"
		class="mt-4"
	>
		<Button kind="secondary" type="submit" busyLabel="Syncing…">
			Sync now
		</Button>
	</form>
);

async function AccountsSummary({ env }: { env: Env }) {
	const banks = await accountsByBank(env.DB);
	const plaidEnabled = enabled(env);
	return (
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
						action={plaidEnabled && <SyncNow />}
					/>
					<div id="accounts-banks">
						{banks.map((b) => (
							<BankGroup
								name={b.name}
								accounts={b.accounts}
								needsAttention={b.needsAttention}
								lastSyncedAt={b.lastSyncedAt}
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
	);
}

// More → Accounts (spec §8): net worth, each linked bank, then the Plaid Link action when configured.
// Before any bank is linked there's nothing to add up, so no $0: the add empty state instead (decision 55).
accounts.get("/accounts", async (c) => {
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
			<AccountsSummary env={c.env} />
		</Layout>,
	);
});

accounts.post("/accounts/sync", async (c) => {
	if (!enabled(c.env)) return c.notFound();
	const recent = await c.env.DB.prepare(
		"SELECT 1 AS recent FROM plaid_items WHERE last_synced_at > datetime('now', '-60 seconds') LIMIT 1",
	).first();
	let message: string;
	if (recent) {
		message = "Synced just now.";
	} else {
		const result = await syncAllItems(c.env);
		await applyMerchantRules(c.env.DB);
		message =
			result.added === 0
				? "Nothing new"
				: `${result.added} new ${result.added === 1 ? "transaction" : "transactions"}`;
	}
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	return c.html(<AccountsSummary env={c.env} />);
});
