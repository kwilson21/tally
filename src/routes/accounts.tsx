import { type Context, Hono } from "hono";
import { categorizePending } from "../categorize-pending";
import { accountsByBank, type Bank, netWorthCents } from "../db/accounts";
import { applyMerchantRules } from "../db/transactions";
import { type SyncAllResult, syncAllItems } from "../plaid/sync-all";
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
/** The whole Accounts page; `alert` is a failed no-JavaScript Sync now. */
function accountsPage(c: Context<App>, alert?: string) {
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
			<AccountsSummary env={c.env} alert={alert} />
		</Layout>,
	);
}

accounts.get("/accounts", (c) => accountsPage(c));

/** What a manual sync did, in words, or an alert when a bank failed. */
function syncOutcome(
	result: SyncAllResult,
	banks: Bank[],
): { alert: string } | { message: string; type: "success" | "info" } {
	if (result.failed > 0)
		return {
			alert: `Couldn't sync ${result.failedBanks.join(", ")}. Try again later.`,
		};
	if (result.synced === 0 && result.busy > 0)
		return { message: "Already synced a moment ago.", type: "info" };
	if (result.synced === 0 && banks.every((b) => b.needsAttention))
		return { message: "Fix the connection first.", type: "info" };
	if (result.added === 0) return { message: "Nothing new", type: "success" };
	return {
		message: `${result.added} new ${result.added === 1 ? "transaction" : "transactions"}`,
		type: "success",
	};
}

// Sync now (P12 A): every healthy bank, at most once a minute each. Merchant rules run before the
// answer so the count and list are right; Jev, as at night, runs after it (decision 56's cap).
// A failure is said once, in the summary's alert, like Fix connection; success is a toast plus announce.
accounts.post("/accounts/sync", async (c) => {
	if (!enabled(c.env)) return c.notFound();
	const isHtmx = c.req.header("HX-Request") === "true";
	let alert: string | undefined;
	try {
		const result = await syncAllItems(c.env, undefined, Date.now, true);
		await applyMerchantRules(c.env.DB);
		if (result.synced > 0) {
			c.executionCtx.waitUntil(
				categorizePending(c.env).catch((error: unknown) => {
					console.error(
						"manual sync categorize failed",
						error instanceof Error ? error.name : "unknown",
					);
				}),
			);
		}
		const outcome = syncOutcome(result, await accountsByBank(c.env.DB));
		if ("alert" in outcome) alert = outcome.alert;
		else if (!isHtmx) return c.redirect("/accounts", 303);
		else
			c.header(
				"HX-Trigger",
				JSON.stringify({
					toast: { message: outcome.message, type: outcome.type },
					announce: outcome.message,
				}),
			);
	} catch (error) {
		console.error(
			"manual sync failed",
			error instanceof Error ? error.name : "unknown",
		);
		alert = "Couldn't sync accounts. Try again later.";
	}
	// Without htmx a failure can't ride a redirect, so the whole page carries the alert.
	if (!isHtmx) return accountsPage(c, alert);
	return c.html(<AccountsSummary env={c.env} alert={alert} />);
});
