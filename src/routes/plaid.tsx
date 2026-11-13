import * as Effect from "effect/Effect";
import { Hono } from "hono";
import { actor } from "../actor";
import { householdToday } from "../dates";
import {
	isSetUp,
	readFirstTally,
	strokeStatement,
	takeBackQuestionStrokes,
} from "../db/first-tally";
import { hxTrigger } from "../htmx";
import { PlaidBank } from "../machines/bank-request";
import { askBank, plaidBankFor } from "../plaid/bank-request";
import {
	createLinkToken,
	exchangePublicToken,
	getInstitutionName,
	getItem,
	type LinkTokenRequest,
	type PlaidEnv,
	PlaidError,
	removeItem,
} from "../plaid/client";
import { clearAttention, readConnection } from "../plaid/item-store";
import { syncItemAndSort } from "../plaid/sort-after-sync";
import { decryptToken, encryptToken, isValidKey } from "../plaid/token-crypto";
import { linkBank } from "../rules/accounts";
import { decided } from "../rules/terms";

type PlaidBindings = PlaidEnv & { DEMO?: string };

type Bindings = Env & PlaidBindings;

type App = { Bindings: Bindings; Variables: { actor: string } };

export const plaid = new Hono<App>();

export function enabled(env: PlaidBindings) {
	return (
		env.DEMO !== "true" &&
		Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET) &&
		isValidKey(env.TOKEN_ENCRYPTION_KEY)
	);
}

async function clientUserId(email: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(email.toLowerCase()),
	);

	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** True for a value that is text (a file part is not a token). */
function isText(value: unknown): value is string {
	return typeof value === "string";
}

/** The Link request with the webhook URL, when one is set. */
function withWebhook(
	webhookUrl: string | undefined,
	request: LinkTokenRequest,
): LinkTokenRequest {
	if (webhookUrl) request.webhook = webhookUrl;

	return request;
}

function linkFailure(cause: unknown) {
	logPlaidRequestId(cause);

	return <p role="alert">Couldn't link the bank. Try again.</p>;
}

function repairFailure(cause: unknown) {
	logPlaidRequestId(cause);

	return <p role="alert">Couldn't fix the connection. Try again.</p>;
}

async function storedItem(db: D1Database, id: string) {
	if (!/^\d+$/.test(id)) return null;

	return db
		.prepare(
			"SELECT id, access_token_encrypted, institution_name FROM plaid_items WHERE id = ? AND disconnected_at IS NULL",
		)
		.bind(Number(id))
		.first<{
			id: number;
			access_token_encrypted: ArrayBuffer;
			institution_name: string;
		}>();
}

function logPlaidRequestId(cause: unknown) {
	if (cause instanceof PlaidError && cause.request_id) {
		console.error("Plaid request failed", { request_id: cause.request_id });
	}
}

function isSameOrigin(request: Request) {
	if (request.headers.get("Sec-Fetch-Site") === "same-origin") return true;
	const origin = request.headers.get("Origin");

	return origin !== null && origin === new URL(request.url).origin;
}

plaid.post("/plaid/link-token", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.body(null, 403);

	if (!enabled(c.env)) return c.notFound();

	try {
		const result = await createLinkToken(
			c.env,
			withWebhook(c.env.PLAID_WEBHOOK_URL, {
				user: { client_user_id: await clientUserId(actor(c)) },
				client_name: "Tally",
				products: ["transactions"],
				country_codes: ["US"],
				language: "en",
			}),
		);

		return c.json({ link_token: result.link_token });
	} catch (error) {
		return c.html(linkFailure(error), 502);
	}
});

plaid.post("/plaid/items/:id/link-token", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.body(null, 403);

	if (!enabled(c.env)) return c.notFound();
	const item = await storedItem(c.env.DB, c.req.param("id"));

	if (!item) return c.notFound();

	try {
		const accessToken = await decryptToken(
			item.access_token_encrypted,
			c.env.TOKEN_ENCRYPTION_KEY ?? "",
		);

		const result = await createLinkToken(
			c.env,
			withWebhook(c.env.PLAID_WEBHOOK_URL, {
				user: { client_user_id: await clientUserId(actor(c)) },
				client_name: "Tally",
				access_token: accessToken,
				country_codes: ["US"],
				language: "en",
			}),
		);

		return c.json({ link_token: result.link_token });
	} catch (error) {
		return c.html(repairFailure(error), 502);
	}
});

plaid.post("/plaid/items/:id/repaired", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.body(null, 403);

	if (!enabled(c.env)) return c.notFound();
	const item = await storedItem(c.env.DB, c.req.param("id"));

	if (!item) return c.notFound();

	try {
		// The request waits for Plaid inside the bridged machine (decision 210): the bank is fixed only once Plaid says
		// its login works. What Plaid answered is logged where it is asked.
		const from = await readConnection(c.env.DB, item.id);

		if (from === null) return c.notFound();

		const landed = await Effect.runPromise(
			askBank(from, "FIX").pipe(
				Effect.provideService(PlaidBank, plaidBankFor(c.env, item)),
			),
		);

		if (landed.outcome === "waiting") return c.notFound();

		if (landed.outcome !== "done") return c.html(repairFailure(null), 502);

		let repaired = await clearAttention(c.env.DB, item.id);

		if (repaired === "lost-race") {
			// The bank moved between the read and the write. If a sync made it ok meanwhile, the repair has held: the
			// success path. Anything else is a real failure.
			repaired =
				(await readConnection(c.env.DB, item.id)) === "ok"
					? "unchanged"
					: "lost-race";
		}

		if (repaired === "refused") return c.notFound();

		if (repaired === "lost-race") return c.html(repairFailure(null), 502);
		c.executionCtx.waitUntil(
			syncItemAndSort(c.env, item.id).catch((error) => {
				logPlaidRequestId(error);
			}),
		);
		const message = `Fixed ${item.institution_name}.`;
		c.header(
			"HX-Trigger",
			hxTrigger({
				toast: { message, type: "success" },
				announce: message,
			}),
		);

		return c.body(null, 204);
	} catch (error) {
		return c.html(repairFailure(error), 502);
	}
});

plaid.post("/plaid/exchange", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.body(null, 403);

	if (!enabled(c.env)) return c.notFound();
	const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim();

	if (
		contentType !== "application/x-www-form-urlencoded" &&
		contentType !== "multipart/form-data"
	) {
		return c.html(linkFailure(undefined), 415);
	}

	let publicToken: unknown;

	try {
		publicToken = (await c.req.formData()).get("public_token");
	} catch {
		return c.html(linkFailure(undefined), 422);
	}

	if (!isText(publicToken) || publicToken.length === 0) {
		return c.html(linkFailure(undefined), 422);
	}

	try {
		const exchanged = await exchangePublicToken(c.env, publicToken);
		let institution = "Your bank";

		try {
			const item = await getItem(c.env, exchanged.access_token);

			if (item.item.institution_id) {
				institution =
					(await getInstitutionName(c.env, item.item.institution_id)) ||
					institution;
			}
		} catch (error) {
			logPlaidRequestId(error);
		}

		// Linking draws stroke one on the household's day, in the same batch as the bank (spec §8.8). The setup
		// announcement is said only while the first week is still to do. The read sits inside the try, so a failure
		// there removes the Item too: Plaid's token is never stored.
		let announceReading: boolean;
		let itemId: number;

		try {
			const asked = decided(
				linkBank.decide(
					{
						institution,
						plaidItemId: exchanged.item_id,
						who: actor(c),
						today: await householdToday(c.env.DB),
					},
					{ settingUp: !isSetUp(await readFirstTally(c.env.DB)) },
				),
			);

			// Linking has no refusal and always has something to save; the rule names what.
			if (asked.kind !== "write") throw new Error("link refused");
			const link = asked.save;
			announceReading = link.announceReading;

			const encrypted = await encryptToken(
				exchanged.access_token,
				c.env.TOKEN_ENCRYPTION_KEY ?? "",
			);

			// D1 returns the batch's results in statement order, so the first is the bank's insert and its last_row_id is the new row.
			const [inserted] = await c.env.DB.batch([
				c.env.DB.prepare(
					"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, ?, ?, ?)",
				).bind(encrypted, link.institution, link.who, link.plaidItemId),
				strokeStatement(c.env.DB, "bank", link.today),
				// A bank linked during setup takes the questions back (#578): the new bank's deposits and charges are asked again.
				takeBackQuestionStrokes(c.env.DB, link.institution),
			]);

			itemId = Number(inserted?.meta.last_row_id);
		} catch (error) {
			try {
				await removeItem(c.env, exchanged.access_token);
			} catch (removeError) {
				logPlaidRequestId(removeError);
			}

			throw error;
		}

		// Plaid sends SYNC_UPDATES_AVAILABLE only after an Item's first /transactions/sync, so linking starts that sync (spec §10).
		c.executionCtx.waitUntil(
			syncItemAndSort(c.env, itemId).catch((error) => {
				logPlaidRequestId(error);
			}),
		);

		const message = announceReading
			? `${institution} is linked. Tally's reading your last 90 days.`
			: `Linked ${institution}.`;

		c.header(
			"HX-Trigger",
			hxTrigger({
				toast: { message, type: "success" },
				announce: message,
			}),
		);

		return c.body(null, 204);
	} catch (error) {
		return c.html(linkFailure(error), 502);
	}
});
