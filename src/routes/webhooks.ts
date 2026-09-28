import { Hono } from "hono";
import { type PlaidEnv, PlaidError } from "../plaid/client";
import { loginStillBroken } from "../plaid/login-broken";
import { syncItem, TRANSIENT_ITEM_ERROR_CODES } from "../plaid/sync";
import { verifyPlaidWebhook } from "../plaid/webhook-verify";
import { enabled } from "./plaid";

type App = { Bindings: Env & PlaidEnv };
type Webhook = {
	item_id?: unknown;
	webhook_type?: unknown;
	webhook_code?: unknown;
	error?: { error_code?: unknown };
};

const attentionCodes = new Set([
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
		"SELECT id, access_token_encrypted, status FROM plaid_items WHERE plaid_item_id = ?",
	)
		.bind(body.item_id)
		.first<{
			id: number;
			access_token_encrypted: ArrayBuffer;
			status: string;
		}>();
	if (!item) return c.body(null, 200);

	if (
		body.webhook_type === "TRANSACTIONS" &&
		body.webhook_code === "SYNC_UPDATES_AVAILABLE"
	) {
		c.executionCtx.waitUntil(
			syncItem(c.env, item.id).catch((error: unknown) => {
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
		await c.env.DB.prepare(
			"UPDATE plaid_items SET status = 'needs_attention' WHERE id = ?",
		)
			.bind(item.id)
			.run();
	}
	if (isItemError) {
		c.executionCtx.waitUntil(
			(async () => {
				if (await loginStillBroken(c.env, item.access_token_encrypted)) {
					await c.env.DB.prepare(
						"UPDATE plaid_items SET status = 'needs_attention' WHERE id = ? AND status = ?",
					)
						.bind(item.id, item.status)
						.run();
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
