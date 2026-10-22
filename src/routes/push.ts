// POST /push/subscribe (decision 148): one device's Web Push subscription, from the notify control's script (public/js/push.js).
// A form post, so Hono's csrf check applies (sameOrigin). The three fields are checked before anything is stored: the endpoint
// is https and at most 2,000 characters; the key is an uncompressed P-256 point that imports on the curve (RFC 8291 §7); the
// auth secret is 16 bytes. Input that fails answers 422. Web Push that is off (the demo, or no keys) answers 404, as does a
// person who isn't signed in or is removed. Otherwise the device is stored for the signed-in person, or moved to them if it
// was stored for someone else (a shared device belongs to whoever turned it on last), and the answer is 204. A page load's
// quiet re-post carries restore=1: it brings a lost row back, but never moves one, so opening Home on a shared device does
// not hand it to whoever is looking.

import { Hono } from "hono";
import { actor } from "../actor";
import { fromBase64Url } from "../push/base64url";
import { vapidKeys } from "../push/keys";

type App = { Bindings: Env; Variables: { actor: string } };

export const push = new Hono<App>();

/** The longest endpoint stored: a push service's URL is far shorter (decision 148). */
const MAX_ENDPOINT_LENGTH = 2000;

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

/** A form field as text, or null when it is missing or a file. */
const fieldOf = (form: Record<string, unknown>, name: string) => {
	const value = form[name];
	return typeof value === "string" ? value : null;
};

/** The three subscription fields as the browser sent them, or null when any one is not a valid subscription. */
async function subscriptionOf(form: Record<string, unknown>) {
	const endpoint = fieldOf(form, "endpoint");
	if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) return null;
	try {
		if (new URL(endpoint).protocol !== "https:") return null;
	} catch {
		return null;
	}
	const p256dh = fieldOf(form, "p256dh");
	const point = p256dh ? fromBase64Url(p256dh) : null;
	if (!p256dh || point?.length !== 65 || point[0] !== 0x04) return null;
	try {
		// RFC 8291 §7: the key must be on the curve, which an import checks.
		await crypto.subtle.importKey("raw", point, P256, false, []);
	} catch {
		return null;
	}
	const auth = fieldOf(form, "auth");
	const secret = auth ? fromBase64Url(auth) : null;
	if (!auth || secret?.length !== 16) return null;
	return { endpoint, p256dh, auth };
}

const INSERT_SQL =
	"INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)";

/** A tap: the device is stored for the person who tapped, and moves to them from whoever had it. */
const TAP_SQL = `${INSERT_SQL} ON CONFLICT(endpoint) DO UPDATE SET member_email = excluded.member_email, p256dh = excluded.p256dh, auth = excluded.auth`;

/** The quiet re-post on a page load (restore=1): a lost row comes back, but an existing row keeps its owner (decision 148). */
const RESTORE_SQL = `${INSERT_SQL} ON CONFLICT(endpoint) DO NOTHING`;

push.post("/push/subscribe", async (c) => {
	const form = (await c.req.parseBody()) as Record<string, unknown>;
	const subscription = await subscriptionOf(form);
	if (!subscription) return c.body(null, 422);
	if (!(await vapidKeys(c.env))) return c.body(null, 404);
	let member: string;
	try {
		member = actor(c);
	} catch {
		return c.body(null, 404);
	}
	const current = await c.env.DB.prepare(
		"SELECT 1 AS present FROM household_members WHERE email = ? AND removed_at IS NULL",
	)
		.bind(member)
		.first();
	if (!current) return c.body(null, 404);
	await c.env.DB.prepare(form.restore === "1" ? RESTORE_SQL : TAP_SQL)
		.bind(member, subscription.endpoint, subscription.p256dh, subscription.auth)
		.run();
	return c.body(null, 204);
});
