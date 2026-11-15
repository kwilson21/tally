import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { plaidItems } from "../db/schema";
import { type PlaidEnv, PlaidError } from "../plaid/client";
import { connectionOf, markNeedsAttention } from "../plaid/item-store";
import { loginStillBroken } from "../plaid/login-broken";
import { syncItemAndSort } from "../plaid/sort-after-sync";
import { TRANSIENT_ITEM_ERROR_CODES } from "../plaid/sync";
import { readWebhookBody } from "../plaid/webhook-body";
import { verifyPlaidWebhook } from "../plaid/webhook-verify";
import { enabled } from "./plaid";

type App = { Bindings: Env & PlaidEnv };

// What each webhook this file handles needs, checked against plaid.com/docs/api/items (decision 173):
//
//   Webhook                                     Needs                                    Flag
//   ITEM ERROR (not a transient code)           a login problem (update mode fixes it)  login: a good sync clears it
//   PENDING_EXPIRATION                          update mode (UK and EU)                  relink: only a relink clears it
//   PENDING_DISCONNECT                          update mode (US and CA)                  relink: only a relink clears it
//   USER_PERMISSION_REVOKED                     update mode, or a fresh relink           relink: only a relink clears it
//   TRANSACTIONS SYNC_UPDATES_AVAILABLE         a sync                                   none: it syncs the bank
//   everything else (LOGIN_REPAIRED,            nothing for Tally to flag                none: ignored, as before
//   NEW_ACCOUNTS_AVAILABLE, WEBHOOK_UPDATE_     (USER_ACCOUNT_REVOKED is not handled
//   ACKNOWLEDGED, USER_ACCOUNT_REVOKED, ...)     here, as before)
//
// Only the relink codes below set the held flag, so a good sync never clears them.
const relinkCodes = new Set([
	"PENDING_EXPIRATION",
	"PENDING_DISCONNECT",
	"USER_PERMISSION_REVOKED",
]);

const transientErrors = new Set<string>(TRANSIENT_ITEM_ERROR_CODES);

export const webhooks = new Hono<App>();

webhooks.post("/webhooks/plaid", async (c) => {
	if (!enabled(c.env)) return c.notFound();
	const rawBody = await c.req.text();

	const verification = await verifyPlaidWebhook(
		c.env,
		rawBody,
		c.req.header("Plaid-Verification"),
	);

	if (verification === "unavailable") return c.body(null, 503);

	if (verification === "invalid") return c.body(null, 401);
	const read = readWebhookBody(rawBody);

	if (read.kind === "not-json") return c.body(null, 400);

	if (read.kind === "not-object") return c.body(null, 200);

	const { body } = read;

	if (body.item_id === undefined) return c.body(null, 200);

	const item = await drizzle(c.env.DB)
		.select({
			id: plaidItems.id,
			// Raw bytes: the column is read as SQL so the token stays the D1 blob, unchanged (decryptToken takes ArrayBuffer or Uint8Array).
			access_token_encrypted: sql<ArrayBuffer>`${plaidItems.accessTokenEncrypted}`,
			status: plaidItems.status,
			disconnected_at: plaidItems.disconnectedAt,
			attention_login: plaidItems.attentionLogin,
			attention_held: plaidItems.attentionHeld,
			connection_revision: plaidItems.connectionRevision,
		})
		.from(plaidItems)
		.where(eq(plaidItems.plaidItemId, body.item_id))
		.get();

	if (!item) return c.body(null, 200);

	if (item.disconnected_at !== null) return c.body(null, 200);

	if (
		body.webhook_type === "TRANSACTIONS" &&
		body.webhook_code === "SYNC_UPDATES_AVAILABLE"
	) {
		// Then Jev sorts what arrived, when the household's switch is on (spec §8.6, decision 68). A sync the webhook
		// starts runs after Plaid said the history is in when historical_update_complete is true (#581).
		c.executionCtx.waitUntil(
			syncItemAndSort(c.env, item.id, undefined, {
				historyComplete: body.historical_update_complete === true,
			}).catch((cause: unknown) => {
				const requestId =
					cause instanceof PlaidError ? cause.request_id : undefined;

				console.error(`plaid webhook sync error ${requestId ?? ""}`.trim());
			}),
		);

		return c.body(null, 200);
	}

	const itemError = body.error?.error_code;

	const isItemError =
		body.webhook_type === "ITEM" &&
		body.webhook_code === "ERROR" &&
		!(itemError !== undefined && transientErrors.has(itemError));

	const isRelinkWarning =
		body.webhook_type === "ITEM" &&
		body.webhook_code !== undefined &&
		relinkCodes.has(body.webhook_code);

	if (isRelinkWarning) {
		// No `seen` is passed here, so the store reads the bank now, and a race with a sync or a relink is tried again
		// against the latest state. A relink warning is never made stale by a repair or a sync, so it must not be
		// dropped (decision 173). Only a race it loses three times comes back here as lost-race: the warning did not
		// land, so the answer is 503, and Plaid sends the webhook again.
		const result = await markNeedsAttention(c.env.DB, item.id, "relink");

		if (result === "lost-race") {
			console.error(
				`plaid webhook ${String(body.webhook_code)} lost a race for item ${item.id}`,
			);

			return c.body(null, 503);
		}
	}

	if (isItemError) {
		c.executionCtx.waitUntil(
			(async () => {
				if (await loginStillBroken(c.env, item.access_token_encrypted)) {
					// The state and revision this request started from are passed as `seen`, and not retried. A login
					// error that was reported before a repair or a good sync is stale once that has landed, so it is
					// dropped and logged as lost-race. This runs after the 200 is sent, so Plaid is not asked to send it again.
					const result = await markNeedsAttention(c.env.DB, item.id, "login", {
						seen: {
							state: connectionOf(item),
							revision: item.connection_revision,
						},
					});

					if (result === "lost-race") {
						console.error(
							`plaid webhook ITEM error lost a race for item ${item.id}`,
						);
					}
				}
			})().catch((cause: unknown) => {
				const requestId =
					cause instanceof PlaidError ? cause.request_id : undefined;

				console.error(`plaid webhook item error ${requestId ?? ""}`.trim());
			}),
		);
	}

	return c.body(null, 200);
});
