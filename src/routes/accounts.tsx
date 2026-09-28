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
		<Button id="sync-now" kind="secondary" type="submit" busyLabel="Syncing…">
			Sync now
		</Button>
	</form>
);

async function AccountsSummary({ env, alert }: { env: Env; alert?: string }) {
	const banks = await accountsByBank(env.DB);
	const plaidEnabled = enabled(env);
	return (
		<div id="accounts-summary">
			{alert && (
				<p role="alert" class="mb-4 text-negative">
					{alert}
				</p>
			)}
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
								lastSyncedAt={env.DEMO === "true" ? undefined : b.lastSyncedAt}
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
	const isHtmx = c.req.header("HX-Request") === "true";
	try {
		const result = await syncAllItems(c.env, undefined, Date.now, true);
		await applyMerchantRules(c.env.DB);
		const message =
			result.failed > 0
				? `Couldn't sync ${result.failedBanks.join(", ")}. Try again later.`
				: result.synced === 0 && result.skipped > 0
					? "Synced just now"
					: result.added === 0
						? "Nothing new"
						: `${result.added} new ${result.added === 1 ? "transaction" : "transactions"}`;
		if (!isHtmx) return c.redirect("/accounts", 303);
		c.header(
			"HX-Trigger",
			JSON.stringify({
				toast: { message, type: result.failed ? "error" : "success" },
				announce: message,
			}),
		);
		return c.html(
			<AccountsSummary
				env={c.env}
				alert={result.failed ? message : undefined}
			/>,
		);
	} catch (error) {
		console.error(
			"manual sync failed",
			error instanceof Error ? error.name : "unknown",
		);
		if (!isHtmx) return c.redirect("/accounts", 303);
		const message = "Couldn't sync accounts. Try again later.";
		c.header(
			"HX-Trigger",
			JSON.stringify({ toast: { message, type: "error" }, announce: message }),
		);
		return c.html(<AccountsSummary env={c.env} alert={message} />);
	}
});
