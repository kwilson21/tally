// POST /push/subscribe (decision 149): one device's Web Push subscription, from the notify control's script (public/js/push.js).
// A form post, so Hono's csrf check applies (sameOrigin). The three fields are checked before anything is stored: the endpoint
// is at most 2,000 characters and a browser's push service over https (push/endpoint.ts); the key is an uncompressed P-256
// point that imports on the curve (RFC 8291 §7); the
// auth secret is 16 bytes. Input that fails answers 422. Web Push that is off (the demo, or no keys) answers 404, as does a
// person who isn't signed in or is removed. Otherwise the device is stored for the signed-in person, or moved to them if it
// was stored for someone else (a shared device belongs to whoever turned it on last), and the answer is 204. A page load's
// quiet re-post carries restore=1: it brings a lost row back and never moves one. A device stored for someone else answers
// 409, so opening Home on a shared device does not hand it to whoever is looking, and the page shows that device as Off.

import { Hono } from "hono";
import { actor } from "../actor";
import { fromBase64Url } from "../push/base64url";
import { isPushServiceEndpoint } from "../push/endpoint";
import { vapidKeys } from "../push/keys";

type App = { Bindings: Env; Variables: { actor: string } };

export const push = new Hono<App>();

/** The longest endpoint stored: a push service's URL is far shorter (decision 149). */
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
	if (!isPushServiceEndpoint(endpoint)) return null;
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

// The membership guard is part of the write itself: a row is stored only while the person is a member, so a removal that lands
// after the check above still stores nothing (the write changes no row). ?1 is the person, ?2 to ?4 the device's fields.
const INSERT_SQL = `INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth)
	SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM household_members WHERE email = ?1 AND removed_at IS NULL)`;

/** A tap: the device is stored for the person who tapped, and moves to them from whoever had it. 0 changes: not a member. */
const TAP_SQL = `${INSERT_SQL} ON CONFLICT(endpoint) DO UPDATE SET member_email = excluded.member_email, p256dh = excluded.p256dh, auth = excluded.auth`;

/** The quiet re-post on a page load (restore=1): a lost row comes back, but an existing row is never changed (decision 149). */
const RESTORE_SQL = `${INSERT_SQL} ON CONFLICT(endpoint) DO NOTHING`;

/** The one person a device is stored for, if any. */
const OWNER_SQL =
	"SELECT member_email FROM push_subscriptions WHERE endpoint = ?";

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
	// The early answer for someone who isn't a member. The write below checks membership again, and it is the one that stores.
	const current = await c.env.DB.prepare(
		"SELECT 1 AS present FROM household_members WHERE email = ? AND removed_at IS NULL",
	)
		.bind(member)
		.first();
	if (!current) return c.body(null, 404);
	const row = [
		member,
		subscription.endpoint,
		subscription.p256dh,
		subscription.auth,
	];
	if (form.restore !== "1") {
		const tapped = await c.env.DB.prepare(TAP_SQL)
			.bind(...row)
			.run();
		return c.body(null, tapped.meta.changes ? 204 : 404);
	}
	// A page load's quiet re-post: a missing row is stored for this person. An existing row must already be theirs, and is then
	// left as it is; one that belongs to someone else is not moved here, so the answer is 409 and the page shows the device as Off.
	const restored = await c.env.DB.prepare(RESTORE_SQL)
		.bind(...row)
		.run();
	if (restored.meta.changes) return c.body(null, 204);
	const owner = await c.env.DB.prepare(OWNER_SQL)
		.bind(subscription.endpoint)
		.first<{ member_email: string }>();
	return c.body(null, owner?.member_email === member ? 204 : 409);
});
