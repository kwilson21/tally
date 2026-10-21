import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";
import { sameOrigin } from "../src/security";

// The presence check-in (decision 146): POST /home/seen, posted every 30 seconds while Home's first-week setup or the
// questions page is open. It writes the signed-in member's own home_seen_at, at most once in each 30 seconds, and answers
// 204 with no body. The router mounts sameOrigin and the Access identity as src/index.tsx does.
const PERSON = "person@example.com";
const RILEY = "riley@example.com";
const ORIGIN = "http://localhost";
const family = { DB: env.DB, DEMO: "false" } as unknown as Env;
const demo = { DB: env.DB, DEMO: "true" } as unknown as Env;

const router = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
router.use("*", sameOrigin);
router.use("*", async (c, next) => {
	c.set("actor", PERSON);
	await next();
});
router.route("/", home);

const checkIn = (bindings: Env = family, origin = ORIGIN) =>
	router.request(
		"/home/seen",
		{ method: "POST", headers: { Origin: origin } },
		bindings,
	);

/** A member's stored check-in: null before any, and the stored UTC time as D1 writes it. */
const seenOf = async (email: string) =>
	(
		await env.DB.prepare(
			"SELECT home_seen_at AS seen FROM household_members WHERE email = ?",
		)
			.bind(email)
			.first<{ seen: string | null }>()
	)?.seen ?? null;

/** Sets a member's check-in to a SQLite time modifier from now, such as '-10 seconds'. */
const setSeen = (email: string, when: string | null) =>
	env.DB.prepare(
		"UPDATE household_members SET home_seen_at = CASE WHEN ?2 IS NULL THEN NULL ELSE datetime('now', ?2) END WHERE email = ?1",
	)
		.bind(email, when)
		.run();

beforeEach(async () => {
	await resetDemo(env.DB, todayIn(DEFAULT_TIME_ZONE));
	await env.DB.batch([
		env.DB.prepare("DELETE FROM household_members"),
		env.DB.prepare(
			"INSERT INTO household_members (email, last_seen_at) VALUES (?1, datetime('now')), (?2, datetime('now'))",
		).bind(PERSON, RILEY),
	]);
});

describe("POST /home/seen: the presence check-in", () => {
	it("writes the signed-in member's check-in and answers 204 with no body", async () => {
		const res = await checkIn();
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
		expect(await seenOf(PERSON)).not.toBeNull();
	});

	it("writes only the signed-in member's own row", async () => {
		await checkIn();
		expect(await seenOf(RILEY)).toBeNull();
	});

	it("writes nothing again inside 30 seconds of the last check-in", async () => {
		await setSeen(PERSON, "-10 seconds");
		const before = await seenOf(PERSON);
		const res = await checkIn();
		expect(res.status).toBe(204);
		expect(await seenOf(PERSON)).toBe(before);
	});

	it("writes again once 30 seconds have passed", async () => {
		await setSeen(PERSON, "-31 seconds");
		const before = await seenOf(PERSON);
		await checkIn();
		const after = await seenOf(PERSON);
		expect(after).not.toBe(before);
		expect(after !== null && before !== null && after > before).toBe(true);
	});

	it("writes nothing for a removed member, and still answers 204", async () => {
		await env.DB.prepare(
			"UPDATE household_members SET removed_at = datetime('now') WHERE email = ?",
		)
			.bind(PERSON)
			.run();
		const res = await checkIn();
		expect(res.status).toBe(204);
		expect(await seenOf(PERSON)).toBeNull();
	});

	it("refuses a cross-site POST and writes nothing", async () => {
		const res = await checkIn(family, "https://evil.example");
		expect(res.status).toBe(403);
		expect(await seenOf(PERSON)).toBeNull();
	});

	it("writes nothing in the demo, and answers 204", async () => {
		await env.DB.prepare(
			"UPDATE household_members SET home_seen_at = NULL",
		).run();
		const res = await checkIn(demo);
		expect(res.status).toBe(204);
		expect(await seenOf(PERSON)).toBeNull();
	});
});
