import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { push } from "../src/routes/push";
import { sameOrigin } from "../src/security";

// POST /push/subscribe (decision 149): a device's push subscription, sent as a form post from the notify control (push.js). It
// answers 422 for input that isn't a subscription, and 404 when Web Push is off (the demo, or no keys), or the person isn't
// signed in or is removed. Otherwise it stores the device for the signed-in person and answers 204. A device that subscribes
// again is kept as one row, and belongs to whoever turned it on last.

const PERSON = "person@example.com";
const RILEY = "riley@example.com";
const ORIGIN = "http://localhost";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
// RFC 8291's receiver key and auth secret, a valid P-256 point and a 16-byte secret (see web-push.test.ts).
const UA_PUBLIC =
	"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
// RFC 8292's VAPID pair from Appendix A: valid keys, so the route's key check passes.
const AS_PUBLIC =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";

const family = {
	DB: env.DB,
	DEMO: "false",
	VAPID_PUBLIC_KEY: AS_PUBLIC,
	VAPID_PRIVATE_KEY: AS_PRIVATE,
} as unknown as Env;

const router = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
router.use("*", sameOrigin);
router.use("*", async (c, next) => {
	// The test's signed-in person comes from a header, so a test can send a request with no identity at all.
	const who = c.req.header("x-test-actor");
	if (who) c.set("actor", who);
	await next();
});
router.route("/", push);

const b64u = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

/** The subscribe form post, as push.js sends it. */
const subscribe = (
	fields: Record<string, string>,
	{
		bindings = family,
		who = PERSON,
		origin = ORIGIN,
	}: { bindings?: Env; who?: string | null; origin?: string } = {},
) =>
	router.request(
		"/push/subscribe",
		{
			method: "POST",
			headers: {
				Origin: origin,
				"Content-Type": "application/x-www-form-urlencoded",
				...(who === null ? {} : { "x-test-actor": who }),
			},
			body: new URLSearchParams(fields).toString(),
		},
		bindings,
	);

const good = { endpoint: ENDPOINT, p256dh: UA_PUBLIC, auth: AUTH };

const rowsFor = async () => {
	const { results } = await env.DB.prepare(
		"SELECT member_email, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id",
	).all<{
		member_email: string;
		endpoint: string;
		p256dh: string;
		auth: string;
	}>();
	return results;
};

/**
 * The database with the person removed right after the route's membership check, so the removal lands between the check and the
 * write. The write's own guard is what must then store nothing.
 */
function removedRightAfterItsCheck(): D1Database {
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop !== "prepare") {
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
			return (sql: string) => {
				if (!sql.includes("SELECT 1 AS present FROM household_members"))
					return target.prepare(sql);
				return {
					bind: (...values: unknown[]) => ({
						first: async () => {
							const row = await target
								.prepare(sql)
								.bind(...values)
								.first();
							await target
								.prepare(
									"UPDATE household_members SET removed_at = datetime('now') WHERE email = ?",
								)
								.bind(PERSON)
								.run();
							return row;
						},
					}),
				} as unknown as D1PreparedStatement;
			};
		},
	});
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM push_subscriptions"),
		env.DB.prepare("DELETE FROM household_members"),
		env.DB.prepare(
			"INSERT INTO household_members (email, last_seen_at) VALUES ('person@example.com', datetime('now')), ('riley@example.com', datetime('now'))",
		),
	]);
});

describe("POST /push/subscribe: storing a device", () => {
	it("stores the device for the signed-in person and answers 204", async () => {
		const response = await subscribe(good);
		expect(response.status).toBe(204);
		expect(await rowsFor()).toEqual([
			{
				member_email: PERSON,
				endpoint: ENDPOINT,
				p256dh: UA_PUBLIC,
				auth: AUTH,
			},
		]);
	});

	it("keeps one row per endpoint, and gives it to whoever turned it on last", async () => {
		await subscribe(good);
		await subscribe(good, { who: RILEY });
		expect(await rowsFor()).toEqual([
			{
				member_email: RILEY,
				endpoint: ENDPOINT,
				p256dh: UA_PUBLIC,
				auth: AUTH,
			},
		]);
	});
});

describe("POST /push/subscribe: the quiet re-post on a page load (restore=1)", () => {
	it("answers 409 for a device turned on for someone else, and changes nothing", async () => {
		await subscribe(good, { who: RILEY });
		const response = await subscribe({ ...good, restore: "1" });
		expect(response.status).toBe(409);
		expect(await rowsFor()).toEqual([
			{
				member_email: RILEY,
				endpoint: ENDPOINT,
				p256dh: UA_PUBLIC,
				auth: AUTH,
			},
		]);
	});

	it("answers 204 for a device that is already the signed-in person's, and changes nothing", async () => {
		await subscribe(good);
		const response = await subscribe({ ...good, restore: "1" });
		expect(response.status).toBe(204);
		expect(await rowsFor()).toEqual([
			{
				member_email: PERSON,
				endpoint: ENDPOINT,
				p256dh: UA_PUBLIC,
				auth: AUTH,
			},
		]);
	});

	it("answers 409 for someone else's device even when the restore's keys differ, and keeps the stored keys", async () => {
		await subscribe(good, { who: RILEY });
		const response = await subscribe(
			{ ...good, auth: b64u(new Uint8Array(16).fill(9)), restore: "1" },
			{ who: PERSON },
		);
		expect(response.status).toBe(409);
		expect(await rowsFor()).toEqual([
			{
				member_email: RILEY,
				endpoint: ENDPOINT,
				p256dh: UA_PUBLIC,
				auth: AUTH,
			},
		]);
	});

	it("brings back a lost device for the signed-in person", async () => {
		const response = await subscribe({ ...good, restore: "1" });
		expect(response.status).toBe(204);
		expect(await rowsFor()).toEqual([
			{
				member_email: PERSON,
				endpoint: ENDPOINT,
				p256dh: UA_PUBLIC,
				auth: AUTH,
			},
		]);
	});

	it("still moves a device to whoever taps, without restore=1", async () => {
		await subscribe(good, { who: RILEY });
		await subscribe({ ...good, restore: "0" });
		expect((await rowsFor())[0]?.member_email).toBe(PERSON);
	});
});

describe("POST /push/subscribe: input that is not a subscription (422)", () => {
	it("refuses a missing endpoint", async () => {
		expect((await subscribe({ p256dh: UA_PUBLIC, auth: AUTH })).status).toBe(
			422,
		);
	});

	it("refuses an endpoint that is not https", async () => {
		expect(
			(await subscribe({ ...good, endpoint: "http://fcm.googleapis.com/x" }))
				.status,
		).toBe(422);
	});

	it("refuses an endpoint over 2,000 characters", async () => {
		const long = `https://fcm.googleapis.com/${"a".repeat(2000)}`;
		expect((await subscribe({ ...good, endpoint: long })).status).toBe(422);
	});

	it("accepts an endpoint of exactly 2,000 characters on a push service", async () => {
		const exact = `https://fcm.googleapis.com/${"a".repeat(2000 - "https://fcm.googleapis.com/".length)}`;
		expect(exact).toHaveLength(2000);
		expect((await subscribe({ ...good, endpoint: exact })).status).toBe(204);
	});

	it("refuses a key that is not base64url", async () => {
		expect((await subscribe({ ...good, p256dh: "not a key!" })).status).toBe(
			422,
		);
	});

	it("refuses a key of 65 bytes that is not on the P-256 curve", async () => {
		const notOnCurve = new Uint8Array(65).fill(7);
		notOnCurve[0] = 0x04;
		expect(
			(await subscribe({ ...good, p256dh: b64u(notOnCurve) })).status,
		).toBe(422);
	});

	it("refuses a compressed key, which is the wrong length", async () => {
		const compressed = new Uint8Array(33).fill(2);
		expect(
			(await subscribe({ ...good, p256dh: b64u(compressed) })).status,
		).toBe(422);
	});

	it("refuses a 65-byte key that does not start 0x04 (RFC 8291 §7 wants the uncompressed point)", async () => {
		const notUncompressed = new Uint8Array(65).fill(7);
		notUncompressed[0] = 0x02;
		expect(
			(await subscribe({ ...good, p256dh: b64u(notUncompressed) })).status,
		).toBe(422);
		expect(await rowsFor()).toEqual([]);
	});

	it("refuses an auth secret that is not 16 bytes", async () => {
		expect(
			(await subscribe({ ...good, auth: b64u(new Uint8Array(15).fill(1)) }))
				.status,
		).toBe(422);
	});

	it("stores nothing for input that is refused", async () => {
		await subscribe({ ...good, auth: "x" });
		expect(await rowsFor()).toEqual([]);
	});
});

describe("POST /push/subscribe: only a browser's push service (422 otherwise)", () => {
	// Each browser family's push service (push.ts, PUSH_SERVICE_HOSTS). The ready push sends to whatever is stored, so a host
	// that isn't one of these would have the Worker send requests to any https origin.
	it.each([
		[
			"Chrome, Android and most Chromium browsers",
			"https://fcm.googleapis.com/fcm/send/abc",
		],
		[
			"Chrome's host, in capitals and with the default port",
			"https://FCM.GOOGLEAPIS.COM:443/fcm/send/abc",
		],
		["Firefox", "https://updates.push.services.mozilla.com/wpush/v2/abc"],
		["Firefox's bare host", "https://push.services.mozilla.com/wpush/v2/abc"],
		[
			"Safari, on a Mac and the iPhone and iPad web apps",
			"https://web.push.apple.com/QAbc",
		],
		["Edge on Windows", "https://wns2-par02p.notify.windows.com/w/?token=abc"],
	])("stores a device on %s's push service", async (_name, endpoint) => {
		expect((await subscribe({ ...good, endpoint })).status).toBe(204);
		expect((await rowsFor()).map((row) => row.endpoint)).toEqual([endpoint]);
	});

	it.each([
		"https://evil.example/x",
		"https://fcm.googleapis.com.evil.example/x",
		"https://notfcm.googleapis.com/x",
		"https://web.push.apple.com:8443/x",
		"https://push.apple.com.evil.example/x",
		"http://fcm.googleapis.com/x",
	])("answers 422 and stores nothing for %s", async (endpoint) => {
		expect((await subscribe({ ...good, endpoint })).status).toBe(422);
		expect(await rowsFor()).toEqual([]);
	});
});

describe("POST /push/subscribe: the encoded lengths are checked before anything decodes them", () => {
	afterEach(() => vi.restoreAllMocks());

	/**
	 * Watches atob, which base64url decoding calls (src/push/base64url.ts). The texts it is asked to decode come back from the
	 * function, so a test sees whether a value was decoded at all. The filler Q is in no VAPID key or test key.
	 */
	const watchDecoding = () => {
		const spy = vi.spyOn(globalThis, "atob");
		return () => spy.mock.calls.map(([text]) => String(text));
	};

	it("refuses a 1 MB key without decoding it", async () => {
		const decoded = watchDecoding();
		const huge = "Q".repeat(1_000_000);
		expect((await subscribe({ ...good, p256dh: huge })).status).toBe(422);
		expect(decoded().some((text) => text.startsWith("QQQ"))).toBe(false);
	});

	it.each([
		["one character short", "Q".repeat(86)],
		["one character long, unpadded", "Q".repeat(88)],
		[
			"88 characters with one '=' of padding (push.js sends none)",
			`${"Q".repeat(87)}=`,
		],
	])("refuses a key %s without decoding it", async (_name, p256dh) => {
		const decoded = watchDecoding();
		expect((await subscribe({ ...good, p256dh })).status).toBe(422);
		expect(decoded().some((text) => text.startsWith("QQQ"))).toBe(false);
	});

	it("refuses a 1 MB auth secret without decoding it", async () => {
		const decoded = watchDecoding();
		expect(
			(await subscribe({ ...good, auth: "Q".repeat(1_000_000) })).status,
		).toBe(422);
		expect(decoded().some((text) => text.startsWith("QQQ"))).toBe(false);
	});

	it.each([
		["one character short", "Q".repeat(21)],
		["24 characters with '==' of padding", `${"Q".repeat(22)}==`],
	])("refuses an auth secret %s without decoding it", async (_name, auth) => {
		const decoded = watchDecoding();
		expect((await subscribe({ ...good, auth })).status).toBe(422);
		expect(decoded().some((text) => text.startsWith("QQQ"))).toBe(false);
	});

	it("still decodes a valid subscription's keys, and stores it", async () => {
		const decoded = watchDecoding();
		expect((await subscribe(good)).status).toBe(204);
		expect(decoded().some((text) => text.startsWith("BCVxsr7N"))).toBe(true);
		expect(decoded().some((text) => text.startsWith("BTBZMqHH"))).toBe(true);
	});
});

// A multipart body that is not one, so reading it throws: an answer other than 404 shows the body was read.
const unreadable = (bindings: Env, who: string | null = PERSON) =>
	router.request(
		"/push/subscribe",
		{
			method: "POST",
			headers: {
				Origin: ORIGIN,
				"Content-Type": "multipart/form-data; boundary=x",
				...(who === null ? {} : { "x-test-actor": who }),
			},
			body: "this is not a multipart body",
		},
		bindings,
	);

describe("POST /push/subscribe: the checks before the body is read (404 without parsing)", () => {
	it("answers 404 in the demo without reading the body", async () => {
		expect(
			(await unreadable({ ...family, DEMO: "true" } as unknown as Env)).status,
		).toBe(404);
	});

	it("answers 404 with no keys without reading the body", async () => {
		expect(
			(await unreadable({ DB: env.DB, DEMO: "false" } as unknown as Env))
				.status,
		).toBe(404);
	});

	it("answers 404 when no one is signed in without reading the body", async () => {
		expect((await unreadable(family, null)).status).toBe(404);
	});

	it("answers 404 for a removed person without reading the body", async () => {
		await env.DB.prepare(
			"UPDATE household_members SET removed_at = datetime('now') WHERE email = ?",
		)
			.bind(PERSON)
			.run();
		expect((await unreadable(family)).status).toBe(404);
	});

	it("reads the body for a member with keys, so the same unreadable body is not a 404", async () => {
		expect((await unreadable(family)).status).not.toBe(404);
	});
});

describe("POST /push/subscribe: when Web Push is off, or the person isn't a member (404)", () => {
	it("answers 404 in the demo, whatever the keys", async () => {
		const response = await subscribe(good, {
			bindings: { ...family, DEMO: "true" } as unknown as Env,
		});
		expect(response.status).toBe(404);
		expect(await rowsFor()).toEqual([]);
	});

	it("answers 404 with no keys set", async () => {
		const response = await subscribe(good, {
			bindings: {
				DB: env.DB,
				DEMO: "false",
			} as unknown as Env,
		});
		expect(response.status).toBe(404);
		expect(await rowsFor()).toEqual([]);
	});

	it("answers 404 when no one is signed in", async () => {
		expect((await subscribe(good, { who: null })).status).toBe(404);
	});

	it("answers 404 for a removed person, and stores nothing", async () => {
		await env.DB.prepare(
			"UPDATE household_members SET removed_at = datetime('now') WHERE email = ?",
		)
			.bind(PERSON)
			.run();
		expect((await subscribe(good)).status).toBe(404);
		expect(await rowsFor()).toEqual([]);
	});

	it("stores nothing for a tap when the person is removed between the check and the write, and answers 404", async () => {
		const response = await subscribe(good, {
			bindings: { ...family, DB: removedRightAfterItsCheck() },
		});
		expect(response.status).toBe(404);
		expect(await rowsFor()).toEqual([]);
	});

	it("stores nothing for a restore when the person is removed between the check and the write, and answers 409", async () => {
		const response = await subscribe(
			{ ...good, restore: "1" },
			{ bindings: { ...family, DB: removedRightAfterItsCheck() } },
		);
		expect(response.status).toBe(409);
		expect(await rowsFor()).toEqual([]);
	});
});

describe("POST /push/subscribe: other sites", () => {
	it("refuses a form post from another site with 403", async () => {
		expect(
			(await subscribe(good, { origin: "https://evil.example" })).status,
		).toBe(403);
		expect(await rowsFor()).toEqual([]);
	});
});
