import { Hono } from "hono";
import { accountsByBank, netWorthCents } from "../db/accounts";
import { type PlaidEnv, PlaidError, removeItem } from "../plaid/client";
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
		</Layout>,
	);
});

type DisconnectItem = {
	id: number;
	institution_name: string;
	access_token_encrypted: ArrayBuffer;
	status: string;
	account_count: number;
	transaction_count: number;
};

async function disconnectItem(db: D1Database, id: number) {
	return db
		.prepare(
			`SELECT p.id, p.institution_name, p.access_token_encrypted, p.status,
				COUNT(DISTINCT a.id) AS account_count, COUNT(t.id) AS transaction_count
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
}: {
	item: DisconnectItem;
	error?: string;
}) {
	return (
		<Layout
			title={`Disconnect ${item.institution_name}? · Tally`}
			active="accounts"
			demo={false}
		>
			<h1 class="font-serif text-4xl font-semibold tracking-tight">
				Disconnect {item.institution_name}?
			</h1>
			<p class="mt-4 max-w-xl text-muted">
				Tally stops syncing it. Its {item.account_count} accounts and{" "}
				{item.transaction_count} transactions stay, so past months still add up.
			</p>
			{error && (
				<p role="alert" class="mt-4 text-over">
					{error}
				</p>
			)}
			<form method="post" class="mt-8">
				<Chip type="checkbox" name="delete" value="yes">
					Also delete its accounts and transactions
				</Chip>
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

accounts.get("/accounts/:itemId/disconnect", async (c) => {
	if (c.env.DEMO === "true" || !enabled(c.env)) return c.notFound();
	const item = await disconnectItem(c.env.DB, Number(c.req.param("itemId")));
	if (!item || item.status === "disconnected") return c.notFound();
	return c.html(<DisconnectPage item={item} />);
});

accounts.post("/accounts/:itemId/disconnect", async (c) => {
	if (c.env.DEMO === "true" || !enabled(c.env)) return c.notFound();
	const item = await disconnectItem(c.env.DB, Number(c.req.param("itemId")));
	if (!item || item.status === "disconnected") return c.notFound();
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
				error="Couldn't disconnect this bank. Try again."
			/>,
			502,
		);
	}
	const form = await c.req.formData();
	const statements = [];
	if (form.get("delete") === "yes") {
		statements.push(
			c.env.DB.prepare(
				"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = ?)",
			).bind(item.id),
			c.env.DB.prepare(
				"DELETE FROM balance_history WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = ?)",
			).bind(item.id),
			c.env.DB.prepare("DELETE FROM accounts WHERE plaid_item_id = ?").bind(
				item.id,
			),
		);
	}
	statements.push(
		c.env.DB.prepare(
			"UPDATE plaid_items SET status = 'disconnected', access_token_encrypted = X'' WHERE id = ?",
		).bind(item.id),
	);
	await c.env.DB.batch(statements);
	const message = `Disconnected ${item.institution_name}.`;
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	return c.redirect("/accounts", 303);
});
