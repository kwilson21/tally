import { Hono } from "hono";
import { type PlaidEnv, PlaidError } from "../plaid/client";
import { connectionOf, markNeedsAttention } from "../plaid/item-store";
import { loginStillBroken } from "../plaid/login-broken";
import { syncItemAndSort } from "../plaid/sort-after-sync";
import { TRANSIENT_ITEM_ERROR_CODES } from "../plaid/sync";
import { verifyPlaidWebhook } from "../plaid/webhook-verify";
import { enabled } from "./plaid";

type App = { Bindings: Env & PlaidEnv };
type Webhook = {
	item_id?: unknown;
	webhook_type?: unknown;
	webhook_code?: unknown;
	error?: { error_code?: unknown };
	/** On SYNC_UPDATES_AVAILABLE: Plaid's 90-day history is available (#581). */
	historical_update_complete?: unknown;
};

const attentionCodes = new Set([
	"PENDING_EXPIRATION",
	"PENDING_DISCONNECT",
	"USER_PERMISSION_REVOKED",
]);
// Warnings that the login is about to expire: the bank still syncs until then (decision 173).
const expiringCodes = new Set(["PENDING_EXPIRATION", "PENDING_DISCONNECT"]);
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
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return c.body(null, 400);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return c.body(null, 200);
	}
	const body = parsed as Webhook;
	if (typeof body.item_id !== "string") return c.body(null, 200);
	const item = await c.env.DB.prepare(
		"SELECT id, access_token_encrypted, status, disconnected_at, attention_login, attention_held FROM plaid_items WHERE plaid_item_id = ?",
	)
		.bind(body.item_id)
		.first<{
			id: number;
			access_token_encrypted: ArrayBuffer;
			status: string;
			disconnected_at: string | null;
			attention_login: number;
			attention_held: number;
		}>();
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
			}).catch((error: unknown) => {
				const requestId =
					error instanceof PlaidError ? error.request_id : undefined;
				console.error(`plaid webhook sync error ${requestId ?? ""}`.trim());
			}),
		);
		return c.body(null, 200);
	}

	const itemError = body.error?.error_code;
	const isItemError =
		body.webhook_type === "ITEM" &&
		body.webhook_code === "ERROR" &&
		!(typeof itemError === "string" && transientErrors.has(itemError));
	const isAttentionWarning =
		body.webhook_type === "ITEM" &&
		typeof body.webhook_code === "string" &&
		attentionCodes.has(body.webhook_code);
	if (isAttentionWarning) {
		// No `seen` is passed here, so the store reads the bank now, and a race with a sync or a relink is tried again
		// against the latest state. An expiry warning is never made stale by a repair or a sync, so it must not be
		// dropped (decision 173). Only a race it loses three times comes back here as lost-race: the warning did not land, so
		// the answer is 503, and Plaid sends the webhook again.
		const expiring =
			typeof body.webhook_code === "string" &&
			expiringCodes.has(body.webhook_code);
		const result = await markNeedsAttention(
			c.env.DB,
			item.id,
			expiring ? "expiring" : "login",
		);
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
					// The state this request started from is passed as `seen`, and not retried. A login error that was
					// reported before a repair is stale once the repair has landed, so a repair (or a good sync) that
					// lands while Plaid is asked again wins: the write is dropped and logged as lost-race. This runs
					// after the 200 is sent, so Plaid is not asked to send it again.
					const result = await markNeedsAttention(c.env.DB, item.id, "login", {
						seen: connectionOf(item),
					});
					if (result === "lost-race") {
						console.error(
							`plaid webhook ITEM error lost a race for item ${item.id}`,
						);
					}
				}
			})().catch((error: unknown) => {
				const requestId =
					error instanceof PlaidError ? error.request_id : undefined;
				console.error(`plaid webhook item error ${requestId ?? ""}`.trim());
			}),
		);
	}
	return c.body(null, 200);
});
