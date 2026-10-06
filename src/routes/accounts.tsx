import { type Context, Hono } from "hono";
import { householdToday } from "../dates";
import { accountsByBank, type Bank, netWorthCents } from "../db/accounts";
import { accountsWithHistory } from "../db/balance-history";
import { netWorthView } from "../net-worth";
import { type PlaidEnv, PlaidError, removeItem } from "../plaid/client";
import { type SyncAllResult, syncAllItems } from "../plaid/sync-all";
import { decryptToken } from "../plaid/token-crypto";
import { AccountsTop } from "../views/accounts-top";
import { BankGroup } from "../views/bank-group";
import { Button } from "../views/button";
import { Chip } from "../views/chip";
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
	const today = await householdToday(env.DB);
	// One read for the headline's accounts and the line's balances, so they agree.
	const { banks, points, waiting } = await accountsWithHistory(env.DB, today);
	const history = netWorthView(points, today, waiting);
	const plaidEnabled = enabled(env);
	return (
		<div id="accounts-summary">
			{alert && (
				<p role="alert" class="mb-4 text-over">
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
						history={history}
						action={plaidEnabled && <SyncNow />}
					/>
					<div id="accounts-banks">
						{banks.map((b) => (
							<BankGroup
								name={b.name}
								accounts={b.accounts}
								needsAttention={b.needsAttention}
								lastSyncedAt={env.DEMO === "true" ? undefined : b.lastSyncedAt}
								disconnected={b.disconnected}
								manageHref={
									plaidEnabled ? `/accounts/${b.id}/disconnect` : undefined
								}
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
/** Plaid Link's scripts, on every page that can show Link a bank (the disconnect page swaps Accounts in). */
const plaidScripts = (on: boolean) => ({
	scripts: on
		? ["https://cdn.plaid.com/link/v2/stable/link-initialize.js"]
		: [],
	modules: on ? ["/js/plaid-link.js"] : [],
});

/** The whole Accounts page; `alert` is a failed no-JavaScript Sync now. */
function accountsPage(c: Context<App>, alert?: string) {
	const plaidEnabled = enabled(c.env);
	return c.html(
		<Layout
			title="Accounts · Tally"
			active="accounts"
			currentPath={c.req.path + new URL(c.req.url).search}
			demo={c.env.DEMO === "true"}
			{...plaidScripts(plaidEnabled)}
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
	// The banks synced, but sorting what arrived didn't finish, so the list may not be right yet.
	if (result.afterSyncFailed)
		return { alert: "Couldn't sync accounts. Try again later." };
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

// Sync now (P12 A): every healthy bank, at most once a minute each. Merchant rules run inside each
// bank's sync, so the count and list are right when it answers; Jev is left to the nightly job (spec §8.1).
// A failure is said once, in the summary's alert, like Fix connection; success is a toast plus announce.
accounts.post("/accounts/sync", async (c) => {
	if (!enabled(c.env)) return c.notFound();
	const isHtmx = c.req.header("HX-Request") === "true";
	let alert: string | undefined;
	try {
		const result = await syncAllItems(c.env, undefined, Date.now, true);
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

type DisconnectItem = {
	id: number;
	institution_name: string;
	access_token_encrypted: ArrayBuffer;
	status: string;
	disconnected_at: string | null;
	account_count: number;
	transaction_count: number;
};

async function disconnectItem(db: D1Database, id: number) {
	return db
		.prepare(
			`SELECT p.id, p.institution_name, p.access_token_encrypted, p.status, p.disconnected_at,
				COUNT(DISTINCT a.id) AS account_count, COUNT(CASE WHEN t.is_split = 0 THEN 1 END) AS transaction_count
			FROM plaid_items p
			LEFT JOIN accounts a ON a.plaid_item_id = p.id
			LEFT JOIN transactions t ON t.account_id = a.id
			WHERE p.id = ? GROUP BY p.id`,
		)
		.bind(id)
		.first<DisconnectItem>();
}

function DisconnectPage({
	item,
	error,
	deleteHistory = false,
}: {
	item: DisconnectItem;
	error?: string;
	deleteHistory?: boolean;
}) {
	const url = `/accounts/${item.id}/disconnect`;
	return (
		<Layout
			title={`Disconnect ${item.institution_name}? · Tally`}
			active="accounts"
			demo={false}
			{...plaidScripts(true)}
		>
			<h1 class="font-serif text-4xl font-semibold tracking-tight">
				Disconnect {item.institution_name}?
			</h1>
			<p class="mt-4 max-w-xl text-muted">
				Tally stops syncing it. Its {item.account_count}{" "}
				{item.account_count === 1 ? "account" : "accounts"} and{" "}
				{item.transaction_count}{" "}
				{item.transaction_count === 1 ? "transaction" : "transactions"} stay, so
				past months still add up, unless you tick the box below.
			</p>
			{error && (
				<p role="alert" class="mt-4 text-over">
					{error}
				</p>
			)}
			{/* htmx swaps Accounts in with a toast; without JavaScript it posts and is redirected there. */}
			<form
				method="post"
				action={url}
				class="mt-8"
				hx-post={url}
				hx-disable="findAll button[type=submit]"
				hx-target="#main"
				hx-select="#main"
				hx-swap="outerHTML"
			>
				<Chip
					type="checkbox"
					name="delete"
					value="yes"
					checked={deleteHistory}
					describedBy="delete-hint"
				>
					Also delete its accounts and transactions
				</Chip>
				<p id="delete-hint" class="mt-2 text-muted">
					This deletes them for good.
				</p>
				<div class="mt-6 flex items-center gap-3">
					<Button type="submit">Disconnect</Button>
					<Button kind="text" href="/accounts">
						Cancel
					</Button>
				</div>
			</form>
		</Layout>
	);
}

accounts.get("/accounts/:itemId{[0-9]+}/disconnect", async (c) => {
	if (c.env.DEMO === "true" || !enabled(c.env)) return c.notFound();
	const item = await disconnectItem(c.env.DB, Number(c.req.param("itemId")));
	if (!item || item.disconnected_at !== null) return c.notFound();
	return c.html(<DisconnectPage item={item} />);
});

/** Back to Accounts: htmx gets the page with a toast and an announcement; plain browsers are redirected. */
async function backToAccounts(c: Context<App>, message: string) {
	if (!c.req.header("HX-Request")) return c.redirect("/accounts", 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	c.header("HX-Push-Url", "/accounts");
	return accountsPage(c);
}

accounts.post("/accounts/:itemId{[0-9]+}/disconnect", async (c) => {
	if (c.env.DEMO === "true" || !enabled(c.env)) return c.notFound();
	const item = await disconnectItem(c.env.DB, Number(c.req.param("itemId")));
	if (!item) return c.notFound();
	const already = `${item.institution_name} is already disconnected.`;
	if (item.disconnected_at !== null) return backToAccounts(c, already);
	const deleteHistory = (await c.req.formData()).get("delete") === "yes";
	const plaidEnv = c.env as Env & PlaidEnv;
	try {
		const token = await decryptToken(
			item.access_token_encrypted,
			plaidEnv.TOKEN_ENCRYPTION_KEY as string,
		);
		try {
			await removeItem(plaidEnv, token);
		} catch (error) {
			if (
				!(error instanceof PlaidError) ||
				error.error_code !== "ITEM_NOT_FOUND"
			)
				throw error;
		}
	} catch {
		return c.html(
			<DisconnectPage
				item={item}
				deleteHistory={deleteHistory}
				error="Couldn't disconnect this bank. Try again."
			/>,
			502,
		);
	}
	// One batch is one transaction. Each delete runs only while the bank is still connected, and the
	// disconnect comes last, so a second submit (another tab kept the history) deletes nothing.
	const stillConnected =
		"EXISTS (SELECT 1 FROM plaid_items WHERE id = ? AND disconnected_at IS NULL)";
	const statements = deleteHistory
		? [
				c.env.DB.prepare(
					`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = ?) AND ${stillConnected}`,
				).bind(item.id, item.id),
				c.env.DB.prepare(
					`DELETE FROM balance_history WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = ?) AND ${stillConnected}`,
				).bind(item.id, item.id),
				c.env.DB.prepare(
					`DELETE FROM accounts WHERE plaid_item_id = ? AND ${stillConnected}`,
				).bind(item.id, item.id),
			]
		: [];
	statements.push(
		c.env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now'), access_token_encrypted = X'', sync_locked_until = NULL, sync_lock_id = NULL WHERE id = ? AND disconnected_at IS NULL",
		).bind(item.id),
	);
	let results: D1Result[];
	try {
		results = await c.env.DB.batch(statements);
	} catch {
		// Plaid has let go; a retry finishes, since Plaid then answers ITEM_NOT_FOUND.
		return c.html(
			<DisconnectPage
				item={item}
				deleteHistory={deleteHistory}
				error="Your bank was disconnected at Plaid, but Tally couldn't finish. Try again."
			/>,
			502,
		);
	}
	if (results.at(-1)?.meta.changes === 0) return backToAccounts(c, already);
	return backToAccounts(
		c,
		deleteHistory
			? `Disconnected ${item.institution_name} and deleted its history.`
			: `Disconnected ${item.institution_name}.`,
	);
});
