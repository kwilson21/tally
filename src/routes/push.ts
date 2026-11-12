// POST /push/subscribe (decision 149): one device's Web Push subscription, from the notify control's script (public/js/push.js).
// A form post, so Hono's csrf check applies (sameOrigin). The three fields are checked before anything is stored: the endpoint
// is at most 2,000 characters and a browser's push service over https (push/endpoint.ts); the key is an uncompressed P-256
// point that imports on the curve (RFC 8291 §7); the auth secret is 16 bytes. The encoded lengths are checked before any field
// is decoded. Input that fails answers 422. Web Push that is off (the demo, or no keys), and a person who isn't signed in or is
// removed, answer 404 before the body is read. A body whose Content-Length is missing or over 4,096 bytes answers 413 before it
// is read. Otherwise the device is stored for the signed-in person, or moved to them if it
// was stored for someone else (a shared device belongs to whoever turned it on last), and the answer is 204. A person keeps at
// most five devices: the write and the trim of the oldest are one batch (push/devices.ts). A page load's quiet re-post carries
// restore=1: it brings a lost row back and never moves one. A device stored for someone else answers
// 409, so opening Home on a shared device does not hand it to whoever is looking, and the page shows that device as Off.

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Hono } from "hono";
import { actor } from "../actor";
import { runWith } from "../db/database";
import { decideDevice } from "../db/push-saves";
import { fromBase64Url } from "../push/base64url";
import { isPushServiceEndpoint } from "../push/endpoint";
import { vapidKeys } from "../push/keys";
import { subscribeDevice } from "../rules/push";

type App = { Bindings: Env; Variables: { actor: string } };

export const push = new Hono<App>();

/** The longest endpoint stored: a push service's URL is far shorter (decision 149). */
const MAX_ENDPOINT_LENGTH = 2000;

/** The largest body read: a real subscription form is well under 1 KB (decision 149). A body without a Content-Length is refused. */
const MAX_BODY_LENGTH = 4096;

/** The encoded lengths push.js sends, unpadded: 65 bytes of key is 87 base64url characters, and 16 bytes of secret is 22. */
const P256DH_LENGTH = 87;
const AUTH_LENGTH = 22;

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

/**
 * A subscription form at the edge (decision 206): the three fields as text of exactly the lengths push.js sends, checked
 * before anything is decoded, so an oversized value costs nothing more than the check. A file, a list or a missing field
 * is not text and fails.
 */
const SubscriptionFields = Schema.Struct({
	endpoint: Schema.String.check(
		Schema.isMinLength(1),
		Schema.isMaxLength(MAX_ENDPOINT_LENGTH),
	),
	p256dh: Schema.String.check(
		Schema.isMinLength(P256DH_LENGTH),
		Schema.isMaxLength(P256DH_LENGTH),
	),
	auth: Schema.String.check(
		Schema.isMinLength(AUTH_LENGTH),
		Schema.isMaxLength(AUTH_LENGTH),
	),
});

/** Whether the three fields are a real subscription: a browser's push service, a key on the curve, a 16-byte secret. */
async function isSubscription(fields: {
	endpoint: string;
	p256dh: string;
	auth: string;
}) {
	if (!isPushServiceEndpoint(fields.endpoint)) return false;
	const point = fromBase64Url(fields.p256dh);

	if (point?.length !== 65 || point[0] !== 0x04) return false;

	try {
		// RFC 8291 §7: the key must be on the curve, which an import checks.
		await crypto.subtle.importKey("raw", point, P256, false, []);
	} catch {
		return false;
	}

	return fromBase64Url(fields.auth)?.length === 16;
}

/** What the rule's answer becomes: stored (or already there), not a member, or someone else's device. */
type Answered = 204 | 404 | 409;

push.post("/push/subscribe", async (c) => {
	// Web Push off (the demo reads nothing; no keys) and no member signed in are answered before the body is read or parsed.
	if (!(await vapidKeys(c.env))) return c.body(null, 404);
	let member: string;

	try {
		member = actor(c);
	} catch {
		return c.body(null, 404);
	}

	// The early answer for someone who isn't a member. The rule checks membership again on what it reads, and the save's guard
	// holds it to that, so a removal that lands after this check still stores nothing.
	const current = await c.env.DB.prepare(
		"SELECT 1 AS present FROM household_members WHERE email = ? AND removed_at IS NULL",
	)
		.bind(member)
		.first();

	if (!current) return c.body(null, 404);
	// The body is read only when its declared size is a number of bytes within MAX_BODY_LENGTH: a missing or unreadable
	// Content-Length, or a larger one, answers 413 before parseBody reads anything.
	const declared = c.req.header("content-length");

	if (
		!declared ||
		!/^\d{1,9}$/.test(declared) ||
		Number(declared) > MAX_BODY_LENGTH
	)
		return c.body(null, 413);
	const form = await c.req.parseBody();
	const fields = Schema.decodeUnknownResult(SubscriptionFields)(form);

	// The fields are decoded and checked only once their lengths have passed.
	if (!Result.isSuccess(fields) || !(await isSubscription(fields.success)))
		return c.body(null, 422);
	// "1" on a page load's quiet re-post.
	const restore = form.restore === "1";

	// A device already stored for this person is left as it is. A person removed since the early check gets the answer of
	// someone who was never a member on a tap. On a page load's re-post every refusal answers 409, the one answer push.js
	// shows as Off: nothing was stored, whether the device is someone else's or the person was just removed.
	const status = await runWith(
		c.env.DB,
		decideDevice(subscribeDevice, {
			member,
			...fields.success,
			restore,
			// The time of the request, as SQLite writes it in UTC (decision 195: the rule and the save read no clock).
			now: new Date().toISOString().slice(0, 19).replace("T", " "),
		}).pipe(
			Effect.map((): Answered => 204),
			Effect.catchTags({
				NotAMember: () => Effect.succeed<Answered>(restore ? 409 : 404),
				DeviceIsSomeoneElses: () => Effect.succeed<Answered>(409),
			}),
		),
	);

	return c.body(null, status);
});
