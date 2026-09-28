import { Hono } from "hono";
import { actor } from "../actor";
import {
	createLinkToken,
	exchangePublicToken,
	getInstitutionName,
	getItem,
	type PlaidEnv,
	PlaidError,
	removeItem,
} from "../plaid/client";
import { syncItem } from "../plaid/sync";
import { decryptToken, encryptToken, isValidKey } from "../plaid/token-crypto";

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

function linkFailure(error: unknown) {
	logPlaidRequestId(error);
	return <p role="alert">Couldn't link the bank. Try again.</p>;
}

function repairFailure(error: unknown) {
	logPlaidRequestId(error);
	return <p role="alert">Couldn't fix the connection. Try again.</p>;
}

async function storedItem(db: D1Database, id: string) {
	if (!/^\d+$/.test(id)) return null;
	return db
		.prepare(
			"SELECT id, access_token_encrypted, institution_name FROM plaid_items WHERE id = ?",
		)
		.bind(Number(id))
		.first<{
			id: number;
			access_token_encrypted: ArrayBuffer;
			institution_name: string;
		}>();
}

function logPlaidRequestId(error: unknown) {
	if (error instanceof PlaidError && error.request_id) {
		console.error("Plaid request failed", { request_id: error.request_id });
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
		const result = await createLinkToken(c.env, {
			user: { client_user_id: await clientUserId(actor(c)) },
			client_name: "Tally",
			products: ["transactions"],
			country_codes: ["US"],
			language: "en",
			...(c.env.PLAID_WEBHOOK_URL ? { webhook: c.env.PLAID_WEBHOOK_URL } : {}),
		});
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
			c.env.TOKEN_ENCRYPTION_KEY as string,
		);
		const result = await createLinkToken(c.env, {
			user: { client_user_id: await clientUserId(actor(c)) },
			client_name: "Tally",
			access_token: accessToken,
			country_codes: ["US"],
			language: "en",
			...(c.env.PLAID_WEBHOOK_URL ? { webhook: c.env.PLAID_WEBHOOK_URL } : {}),
		});
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
	await c.env.DB.prepare("UPDATE plaid_items SET status = 'ok' WHERE id = ?")
		.bind(item.id)
		.run();
	c.executionCtx.waitUntil(
		syncItem(c.env, item.id).catch((error: unknown) => {
			logPlaidRequestId(error);
		}),
	);
	const message = `Fixed ${item.institution_name}.`;
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message, type: "success" },
			announce: message,
		}),
	);
	return c.body(null, 204);
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
	if (typeof publicToken !== "string" || publicToken.length === 0) {
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
		try {
			const encrypted = await encryptToken(
				exchanged.access_token,
				c.env.TOKEN_ENCRYPTION_KEY as string,
			);
			await c.env.DB.prepare(
				"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by, plaid_item_id) VALUES (?, ?, ?, ?)",
			)
				.bind(encrypted, institution, actor(c), exchanged.item_id)
				.run();
		} catch (error) {
			try {
				await removeItem(c.env, exchanged.access_token);
			} catch (removeError) {
				logPlaidRequestId(removeError);
			}
			throw error;
		}

		const message = `Linked ${institution}.`;
		c.header(
			"HX-Trigger",
			JSON.stringify({
				toast: { message, type: "success" },
				announce: message,
			}),
		);
		return c.body(null, 204);
	} catch (error) {
		return c.html(linkFailure(error), 502);
	}
});
