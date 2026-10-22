import { type Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { addressOf } from "../address";
import { type AppleRow, parseAppleCsv } from "../apple-card/csv";
import { historyStart, importAppleCard } from "../apple-card/import";
import { importWords } from "../apple-card/plan";
import { householdToday } from "../dates";
import {
	type AppleCardAccount,
	accountsByBank,
	appleCardAccount,
	type Bank,
	countedAccounts,
	netWorthCents,
} from "../db/accounts";
import { accountsWithHistory } from "../db/balance-history";
import {
	APPLE_CARD_KEPT,
	forgetCardPayDeposits,
	forgetPayDeposits,
	takeBackBankStrokes,
} from "../db/first-tally";
import {
	APPLE_CARD_SAMPLE_BALANCE_CENTS,
	appleCardSample,
} from "../demo/apple-card-sample";
import { hxTrigger } from "../htmx";
import { toCents } from "../money";
import { netWorthView } from "../net-worth";
import { afterSync } from "../plaid/after-sync";
import { type PlaidEnv, PlaidError, removeItem } from "../plaid/client";
import { sortAfterSync } from "../plaid/sort-after-sync";
import { type SyncAllResult, syncAllItems } from "../plaid/sync-all";
import { decryptToken } from "../plaid/token-crypto";
import { AccountsTop } from "../views/accounts-top";
import { AppleCardGroup, type AppleCardView } from "../views/apple-card-group";
import { AppleCardRemove } from "../views/apple-card-remove";
import { AppleCardSheet } from "../views/apple-card-sheet";
import { BankGroup } from "../views/bank-group";
import { BottomSheet, sheetAttrs } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import {
	LinkBank,
	LinkBankButton,
	LinkBankError,
	plaidScripts,
} from "../views/link-bank";
import { enabled } from "./plaid";

type App = { Bindings: Env; Variables: { actor: string } };
export const accounts = new Hono<App>();

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

/** Apple Card's words (spec §8.10). The errors go under the field they are about; the size gate's go in a toast when htmx asks. */
const NO_FILE = "Choose the CSV file Apple exported.";
const TOO_BIG =
	"This file is over 1 MB. An Apple Card CSV is far smaller, so check it's the right file.";
const COULDNT_TELL =
	"Tally couldn't tell how big this file is. Try the upload again.";
const BAD_BALANCE =
	"Enter the balance as dollars, like 1,240.18, or with a minus for a credit.";
/** The request's most bytes, checked before its body is read: the file's cap and its form fields. */
const REQUEST_CAP = 1_100_000;
/** The file's most bytes, checked after it's read (a year of one card is far smaller). */
const FILE_CAP = 1_000_000;

/** Cancel and the backdrop: back to Accounts with focus on the Apple Card action, and a toast with htmx. */
const CANCEL_ATTRS = {
	"hx-get": "/accounts?focus=apple-card",
	"hx-target": "#accounts-summary",
	"hx-select": "#accounts-summary",
	"hx-swap": "outerHTML",
	"hx-push-url": "/accounts",
};

/** What a refused upload keeps in the sheet: the typed balance, and the words under each field. */
type SheetForm = {
	balance?: string;
	fileError?: string;
	balanceError?: string;
	focus?: "file" | "balance";
};

/** The card as its group draws it. */
function cardView(card: AppleCardAccount): AppleCardView {
	return {
		balanceCents: card.balanceCents,
		balanceOn: card.balanceOn,
		through: card.through,
		removed: card.removedAt !== null,
	};
}

/**
 * The upload sheet, in its `#sheet`: opened (not still), or drawn again with its errors (still, so it doesn't play its
 * arrival again). Its balance hint names the day of the balance that counts now.
 */
async function uploadSheet(
	env: Env,
	today: string,
	form: SheetForm = {},
	still = false,
) {
	const card = await appleCardAccount(env.DB);
	return (
		<div id="sheet">
			<BottomSheet
				labelledBy="apple-card-sheet-title"
				closeHref="/accounts?focus=apple-card"
				closeAttrs={CANCEL_ATTRS}
				still={still}
			>
				<AppleCardSheet
					demo={env.DEMO === "true"}
					balance={form.balance}
					balanceOn={card?.balanceOn ?? null}
					today={today}
					fileError={form.fileError}
					balanceError={form.balanceError}
					focus={form.focus}
					closeHref="/accounts?focus=apple-card"
					closeAttrs={CANCEL_ATTRS}
				/>
			</BottomSheet>
		</div>
	);
}

async function AccountsSummary({
	env,
	alert,
	sheet,
	focus,
}: {
	env: Env;
	alert?: string;
	/** The upload sheet's `#sheet`, open or closed (`uploadSheet`). */
	sheet?: Child;
	/** Focus goes to the Apple Card action: Upload a file, or Add Apple Card while there's no card. */
	focus?: "apple-card";
}) {
	const today = await householdToday(env.DB);
	// One read for the headline's accounts, the line's balances and the Apple Card, so they agree.
	const { banks, points, waiting, appleCard } = await accountsWithHistory(
		env.DB,
		today,
	);
	const history = netWorthView(points, today, waiting);
	const plaidEnabled = enabled(env);
	const demo = env.DEMO === "true";
	const cardKept = appleCard !== null && appleCard.removedAt === null;
	// Add Apple Card waits for the card to be off (none, or removed), and for Tally's history to have a start.
	const addCard = !cardKept && (await historyStart(env.DB, today)) !== null;
	// Nothing to add up before any bank or kept card (decision 55): the empty state, with a removed card's group below it.
	const empty = banks.length === 0 && !cardKept;
	return (
		<div id="accounts-summary">
			{alert && (
				<p role="alert" class="mb-4 text-over">
					{alert}
				</p>
			)}
			{empty ? (
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
						netWorthCents={netWorthCents(countedAccounts(banks, appleCard))}
						history={history}
						action={plaidEnabled && banks.length > 0 && <SyncNow />}
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
				</>
			)}
			{appleCard && (
				<AppleCardGroup
					card={cardView(appleCard)}
					today={today}
					demo={demo}
					focusUpload={focus === "apple-card" && cardKept}
				/>
			)}
			{((plaidEnabled && !empty) || addCard) && (
				<div class="mt-8 flex flex-wrap items-center gap-3">
					{plaidEnabled && !empty && <LinkBankButton />}
					{addCard && (
						<Button
							kind="secondary"
							href="/accounts/apple-card"
							autofocus={focus === "apple-card" && !cardKept}
							{...sheetAttrs("/accounts/apple-card")}
						>
							Add Apple Card
						</Button>
					)}
				</div>
			)}
			{plaidEnabled && !empty && <LinkBankError />}
			{/* The sheet brings its own #sheet (uploadSheet), so the page draws that one id once. */}
			{sheet ?? <div id="sheet" />}
		</div>
	);
}

// More → Accounts (spec §8): net worth, each linked bank, then the Plaid Link action when configured.
// Before any bank is linked there's nothing to add up, so no $0: the add empty state instead (decision 55).
/** The whole Accounts page; `alert` is a failed no-JavaScript Sync now, and `extra` the sheet and focus. */
function accountsPage(
	c: Context<App>,
	alert?: string,
	extra: { sheet?: Child; focus?: "apple-card" } = {},
	status = 200,
) {
	const plaidEnabled = enabled(c.env);
	return c.html(
		<Layout
			title="Accounts · Tally"
			active="accounts"
			currentPath={addressOf(c)}
			demo={c.env.DEMO === "true"}
			{...plaidScripts(plaidEnabled)}
		>
			<AccountsSummary
				env={c.env}
				alert={alert}
				sheet={extra.sheet}
				focus={extra.focus}
			/>
		</Layout>,
		status as 200,
	);
}

accounts.get("/accounts", (c) => {
	const focus =
		c.req.query("focus") === "apple-card" ? "apple-card" : undefined;
	// Cancel from the upload sheet: say so, and put focus back on the action the sheet opened from.
	if (focus && c.req.header("HX-Request")) {
		const message = "Apple Card upload cancelled.";
		c.header(
			"HX-Trigger",
			hxTrigger({ toast: { message, type: "info" }, announce: message }),
		);
	}
	return accountsPage(c, undefined, { focus });
});

/**
 * The upload sheet: Upload a file and Add Apple Card open it in #sheet, which their hx-select takes out of the whole page.
 * Every answer is the whole page, as Savings' sheet GETs are: htmx restores Back and Forward by swapping the whole body,
 * and a bare sheet there would empty the nav and the summary.
 */
accounts.get("/accounts/apple-card", async (c) => {
	const sheet = await uploadSheet(c.env, await householdToday(c.env.DB));
	return accountsPage(c, undefined, { sheet });
});

/** The body's fields, or none when it can't be read as a form (the upload then says there's no file). */
async function readForm(c: Context<App>) {
	try {
		return await c.req.parseBody();
	} catch {
		return {};
	}
}

/**
 * A balance as integer cents: blank is no balance, a leading minus is a credit, and anything else (or a value that isn't
 * a safe whole number of cents) is null. toCents names the text it refused, so the text is dropped, never rethrown.
 */
function parseBalance(text: string): { cents: number | null } | null {
	const trimmed = text.trim();
	if (trimmed === "") return { cents: null };
	try {
		const cents = toCents(trimmed);
		return Number.isSafeInteger(cents)
			? { cents: cents === 0 ? 0 : cents }
			: null;
	} catch {
		return null;
	}
}

/** A refused size gate: htmx keeps the page with one error toast, and a plain browser gets the page with the sheet open. */
async function sizeRefused(
	c: Context<App>,
	today: string,
	words: string,
	isHtmx: boolean,
) {
	if (isHtmx) {
		c.header("HX-Reswap", "none");
		c.header(
			"HX-Trigger",
			hxTrigger({ toast: { message: words, type: "error" }, announce: words }),
		);
		return c.body(null, 422);
	}
	const sheet = await uploadSheet(
		c.env,
		today,
		{ fileError: words, focus: "file" },
		true,
	);
	return accountsPage(c, undefined, { sheet }, 422);
}

/** A refused upload, after its body was read: the sheet again, with its errors and the typed balance; nothing saved. */
async function uploadRefused(
	c: Context<App>,
	today: string,
	form: SheetForm,
	isHtmx: boolean,
) {
	const sheet = await uploadSheet(c.env, today, form, true);
	if (isHtmx) return c.html(<AccountsSummary env={c.env} sheet={sheet} />, 422);
	return accountsPage(c, undefined, { sheet }, 422);
}

/** A saved upload: Accounts again with a toast and focus on the Apple Card action; a plain browser is redirected. */
function uploadDone(c: Context<App>, message: string, isHtmx: boolean) {
	if (!isHtmx) return c.redirect("/accounts", 303);
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message, type: "success" }, announce: message }),
	);
	c.header("HX-Push-Url", "/accounts");
	return c.html(<AccountsSummary env={c.env} focus="apple-card" />);
}

/**
 * The demo's Add the sample (spec §8.10). The sample is dated from the seeded bank's latest transaction, so a second press
 * finds its rows held and says Nothing new. Its balance is the demo's, and its months are the demo's (demoCardMonths).
 */
async function sampleUpload(c: Context<App>, isHtmx: boolean) {
	const today = await householdToday(c.env.DB);
	const latest = await c.env.DB.prepare(
		"SELECT MAX(t.date) AS date FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.plaid_item_id IS NOT NULL",
	).first<{ date: string | null }>();
	const anchor = latest?.date ?? today;
	const read = parseAppleCsv(appleCardSample(anchor));
	// The sample is written by the code above, so a sample that doesn't read is a bug, never a visitor's mistake.
	if (!read.ok) throw new Error("The demo's Apple Card sample doesn't read");
	const result = await importAppleCard(c.env.DB, read.rows, {
		by: c.get("actor"),
		today,
		balanceCents: APPLE_CARD_SAMPLE_BALANCE_CENTS,
	});
	if (!result.ok) throw new Error("The demo's Apple Card sample has no start");
	// The same steps the real upload's rows get, first, so a failure in the months below never drops the sorting.
	await afterUpload(c, result.addedIds);
	try {
		await demoCardMonths(c.env.DB, anchor);
	} catch {
		// Fixed words only: the demo's months are not worth a row or an error's detail in the log.
		console.error("apple card months failed");
	}
	return uploadDone(c, importWords(result, result.historyStart, today), isHtmx);
}

/**
 * The steps an upload's added rows get, as a sync's do: the merchant rules now, then the sorting of the rows added in the
 * background (none on a second press). A failed rules step is logged in fixed words, and the sorting is told it didn't run.
 */
async function afterUpload(c: Context<App>, addedIds: number[]) {
	let rulesFailed = false;
	try {
		await afterSync(c.env.DB);
	} catch {
		rulesFailed = true;
		console.error("apple card rules failed");
	}
	if (addedIds.length > 0)
		c.executionCtx.waitUntil(
			sortAfterSync(
				c.env,
				{ changedIds: addedIds },
				{ rulesApplied: !rulesFailed },
			),
		);
}

/**
 * The demo's card keeps its months: a balance on each day the seeded banks have one, from the first of them, typed on the
 * anchor. Without this the demo's line would start on the day of the sample instead of six months back.
 */
async function demoCardMonths(db: D1Database, anchor: string) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO balance_history (account_id, date, balance_cents)
				SELECT (SELECT id FROM accounts WHERE subtype = 'apple_card'), h.date, ?
				FROM balance_history h JOIN accounts a ON a.id = h.account_id
				WHERE a.plaid_item_id IS NOT NULL
				GROUP BY h.date
				ON CONFLICT(account_id, date) DO UPDATE SET balance_cents = excluded.balance_cents`,
			)
			.bind(APPLE_CARD_SAMPLE_BALANCE_CENTS),
		db
			.prepare(
				`UPDATE accounts SET balance_on = ?, counted_from = (
					SELECT MIN(h.date) FROM balance_history h JOIN accounts b ON b.id = h.account_id WHERE b.plaid_item_id IS NOT NULL
				) WHERE subtype = 'apple_card'`,
			)
			.bind(anchor),
	]);
}

/**
 * Apple Card's upload (spec §8.10, decision 138). The request's size is checked before anything is read; then the file
 * and the balance are checked, and a refusal shows both errors; then the rows are stored in one batch, and the rows
 * added go through the same steps a sync's do. Nothing is saved on a refusal, and no file, row, amount or balance is logged.
 */
accounts.post("/accounts/apple-card", async (c) => {
	const isHtmx = c.req.header("HX-Request") === "true";
	// The demo takes no file: its sample is added instead, and its body is never read (spec §8.10).
	if (c.env.DEMO === "true") return sampleUpload(c, isHtmx);
	const today = await householdToday(c.env.DB);
	// The request's length, before its body is read: a length that isn't digits, or one over the cap, is refused.
	const declared = c.req.header("content-length") ?? "";
	if (!/^\d+$/.test(declared))
		return sizeRefused(c, today, COULDNT_TELL, isHtmx);
	if (Number(declared) > REQUEST_CAP)
		return sizeRefused(c, today, TOO_BIG, isHtmx);

	const form = await readForm(c);
	const file = form.file;
	const balanceText = typeof form.balance === "string" ? form.balance : "";
	let fileError: string | undefined;
	let rows: AppleRow[] | null = null;
	if (!(file instanceof File) || file.name === "") fileError = NO_FILE;
	else if (file.size > FILE_CAP) fileError = TOO_BIG;
	else {
		const read = parseAppleCsv(
			new TextDecoder("utf-8").decode(await file.arrayBuffer()),
		);
		if (read.ok) rows = read.rows;
		else fileError = read.error;
	}
	const balance = parseBalance(balanceText);
	const balanceError = balance === null ? BAD_BALANCE : undefined;
	if (
		fileError !== undefined ||
		balanceError !== undefined ||
		rows === null ||
		balance === null
	)
		return uploadRefused(
			c,
			today,
			{
				balance: balanceText,
				fileError,
				balanceError,
				focus: fileError !== undefined ? "file" : "balance",
			},
			isHtmx,
		);

	const result = await importAppleCard(c.env.DB, rows, {
		by: c.get("actor"),
		today,
		balanceCents: balance.cents,
	});
	if (!result.ok)
		return uploadRefused(
			c,
			today,
			{ balance: balanceText, fileError: result.error, focus: "file" },
			isHtmx,
		);

	// The same steps a sync's rows get: merchant rules and bill matching now, then the sorting in the background.
	await afterUpload(c, result.addedIds);
	return uploadDone(c, importWords(result, result.historyStart, today), isHtmx);
});

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
// bank's sync, so the count and list are right when it answers; Jev then sorts what arrived in the
// background, when the household's switch is on, so the answer never waits for it (spec §8.1, §8.6).
// A failure is said once, in the summary's alert, like Fix connection; success is a toast plus announce.
accounts.post("/accounts/sync", async (c) => {
	if (!enabled(c.env)) return c.notFound();
	const isHtmx = c.req.header("HX-Request") === "true";
	let alert: string | undefined;
	try {
		const result = await syncAllItems(c.env, undefined, Date.now, true);
		// Even when one bank failed, the others may have brought transactions in. Jev is asked about
		// those only. When the rules step failed, the pass applies them itself, as the nightly run does.
		if (result.changedIds.length > 0)
			c.executionCtx.waitUntil(
				sortAfterSync(c.env, result, {
					rulesApplied: !result.afterSyncFailed,
				}),
			);
		const outcome = syncOutcome(result, await accountsByBank(c.env.DB));
		if ("alert" in outcome) alert = outcome.alert;
		else if (!isHtmx) return c.redirect("/accounts", 303);
		else
			c.header(
				"HX-Trigger",
				hxTrigger({
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
	address,
}: {
	item: DisconnectItem;
	error?: string;
	deleteHistory?: boolean;
	/** The address the page was asked for, with its query, so the keys sheet can open over it. */
	address?: string;
}) {
	const url = `/accounts/${item.id}/disconnect`;
	return (
		<Layout
			title={`Disconnect ${item.institution_name}? · Tally`}
			active="accounts"
			demo={false}
			currentPath={address}
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
	return c.html(<DisconnectPage item={item} address={addressOf(c)} />);
});

/** Back to Accounts: htmx gets the page with a toast and an announcement; plain browsers are redirected. */
async function backToAccounts(c: Context<App>, message: string) {
	if (!c.req.header("HX-Request")) return c.redirect("/accounts", 303);
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message, type: "success" }, announce: message }),
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
	// The pay record's copies of the deposits go first, since they are found through the bank's transactions.
	const statements = deleteHistory
		? [
				forgetPayDeposits(c.env.DB, item.id),
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
	// Before setup is done, the last connected bank going takes strokes one to four back (spec §8.8), in this batch.
	statements.push(takeBackBankStrokes(c.env.DB, item.id));
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

/** The card's transactions a person can see: split parts don't count (as Disconnect's page counts them). */
async function cardTransactionCount(db: D1Database, accountId: number) {
	const row = await db
		.prepare(
			"SELECT COUNT(CASE WHEN t.is_split = 0 THEN 1 END) AS n FROM transactions t WHERE t.account_id = ?",
		)
		.bind(accountId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Remove Apple Card's page, as Disconnect's is (spec §8.10): the card leaves net worth, and its rows stay unless ticked. */
function RemovePage({
	count,
	deleteHistory = false,
	error,
	address,
	plaid,
}: {
	count: number;
	deleteHistory?: boolean;
	error?: string;
	/** The address the page was asked for, with its query, so the keys sheet can open over it. */
	address?: string;
	/** Whether Plaid is configured: its form swaps Accounts in, so Link a bank needs Plaid Link's scripts here. */
	plaid: boolean;
}) {
	return (
		<Layout
			title="Remove Apple Card? · Tally"
			active="accounts"
			demo={false}
			currentPath={address}
			{...plaidScripts(plaid)}
		>
			<AppleCardRemove
				count={count}
				deleteHistory={deleteHistory}
				error={error}
			/>
		</Layout>
	);
}

// Remove Apple Card: a card that isn't kept (none, or already removed) has nothing to remove, so the page is not found.
accounts.get("/accounts/apple-card/remove", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const card = await appleCardAccount(c.env.DB);
	if (!card || card.removedAt !== null) return c.notFound();
	return c.html(
		<RemovePage
			count={await cardTransactionCount(c.env.DB, card.id)}
			address={addressOf(c)}
			plaid={enabled(c.env)}
		/>,
	);
});

accounts.post("/accounts/apple-card/remove", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const card = await appleCardAccount(c.env.DB);
	const already = "Apple Card is already removed.";
	// No card (another tab deleted it with its transactions) or a removed one: there's nothing left to remove, as Disconnect's is.
	if (!card || card.removedAt !== null) return backToAccounts(c, already);
	const deleteHistory = (await c.req.formData()).get("delete") === "yes";
	// Keeping the rows only marks the card removed and clears its balance, so it leaves net worth until a balance is typed.
	// Deleting runs the pay cleanup first (it finds the card's rows), then the rows, their balances, and the account last,
	// so the account's changes say whether this removal went through. Each statement needs the card still kept.
	const statements = deleteHistory
		? [
				forgetCardPayDeposits(c.env.DB),
				c.env.DB.prepare(
					`DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE subtype = 'apple_card') AND ${APPLE_CARD_KEPT}`,
				),
				c.env.DB.prepare(
					`DELETE FROM balance_history WHERE account_id IN (SELECT id FROM accounts WHERE subtype = 'apple_card') AND ${APPLE_CARD_KEPT}`,
				),
				c.env.DB.prepare(
					"DELETE FROM accounts WHERE subtype = 'apple_card' AND removed_at IS NULL",
				),
			]
		: [
				c.env.DB.prepare(
					"UPDATE accounts SET removed_at = datetime('now'), balance_on = NULL WHERE subtype = 'apple_card' AND removed_at IS NULL",
				),
			];
	// The count the failure page shows is read before the batch: a failed batch must not be followed by a read that can fail too.
	const count = await cardTransactionCount(c.env.DB, card.id);
	let results: D1Result[];
	try {
		results = await c.env.DB.batch(statements);
	} catch {
		return c.html(
			<RemovePage
				count={count}
				deleteHistory={deleteHistory}
				error="Couldn't remove Apple Card. Try again."
				plaid={enabled(c.env)}
			/>,
			502,
		);
	}
	if (results.at(-1)?.meta.changes === 0) return backToAccounts(c, already);
	return backToAccounts(
		c,
		deleteHistory
			? "Removed Apple Card and deleted its transactions."
			: "Removed Apple Card.",
	);
});
