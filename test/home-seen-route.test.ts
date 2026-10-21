import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { resetDemo } from "../src/demo/reset";
import { home } from "../src/routes/home";
import { sameOrigin } from "../src/security";

// The presence check-in (decision 146): POST /home/seen, posted every 30 seconds while Home's first-week setup or the
// questions page is open. It writes the signed-in member's own home_seen_at, at most once in each 30 seconds. It answers
// 204 with no body, except when Home's check-in shows a step that has moved on: then 200 with HX-Refresh, so the page
// reloads and shows the change. The router mounts sameOrigin and the Access identity as src/index.tsx does.
const PERSON = "person@example.com";
const RILEY = "riley@example.com";
const ORIGIN = "http://localhost";
const TODAY = todayIn(DEFAULT_TIME_ZONE);
const family = { DB: env.DB, DEMO: "false" } as unknown as Env;
const demo = { DB: env.DB, DEMO: "true" } as unknown as Env;

const router = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
router.use("*", sameOrigin);
router.use("*", async (c, next) => {
	c.set("actor", PERSON);
	await next();
});
router.route("/", home);

/** The check-in as a form post. `step` is the step Home's page shows (Home's check-in only); none is the questions page's. */
const checkIn = (bindings: Env = family, origin = ORIGIN, step?: string) =>
	router.request(
		"/home/seen",
		{
			method: "POST",
			headers: {
				Origin: origin,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: step === undefined ? "" : new URLSearchParams({ step }).toString(),
		},
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

const writeRecord = (value: unknown) =>
	env.DB.prepare(
		"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
		.bind(JSON.stringify(value))
		.run();

// Every connected bank still reading its history: the reading step.
const reading = async () => {
	await env.DB.prepare(
		"UPDATE plaid_items SET disconnected_at = NULL, history_complete_at = NULL",
	).run();
	await writeRecord({ strokes: { bank: TODAY }, budgets: {} });
};

// Every history is in and one transaction still waits for Jev: the sorting step.
const sorting = async () => {
	await reading();
	await env.DB.prepare(
		"UPDATE plaid_items SET history_complete_at = datetime('now')",
	).run();
	await env.DB.prepare(
		"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'waiting-seen', '2026-10-02', 1200, 'SHOP' FROM accounts LIMIT 1",
	).run();
};

// Every history is in and nothing waits: the questions are open (the ready phase).
const ready = async () => {
	await reading();
	await env.DB.prepare(
		"UPDATE plaid_items SET history_complete_at = datetime('now')",
	).run();
	await saveAiSwitches(env.DB, { categories: false, income: false });
};

beforeEach(async () => {
	await resetDemo(env.DB, TODAY);
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
		// The demo's actor is "demo": a member with that address would be written if the demo guard were missing.
		await env.DB.prepare(
			"INSERT INTO household_members (email, last_seen_at) VALUES ('demo', datetime('now'))",
		).run();
		await env.DB.prepare(
			"UPDATE household_members SET home_seen_at = NULL",
		).run();
		const res = await checkIn(demo, ORIGIN, "reading");
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Refresh")).toBeNull();
		expect(await seenOf("demo")).toBeNull();
		expect(await seenOf(PERSON)).toBeNull();
	});
});

describe("POST /home/seen: a page whose step has moved on reloads itself (decision 146)", () => {
	it("answers 204 while the step it shows is still the step now", async () => {
		await reading();
		const res = await checkIn(family, ORIGIN, "reading");
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Refresh")).toBeNull();
		expect(await seenOf(PERSON)).not.toBeNull();
	});

	it("answers 204 while the sort the page shows is still running", async () => {
		await sorting();
		const res = await checkIn(family, ORIGIN, "sorting");
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Refresh")).toBeNull();
	});

	it("answers 200 with HX-Refresh once a slow page's questions open, and still writes its check-in", async () => {
		await sorting();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = datetime('now', '-2 hours')",
		).run();
		const slow = await checkIn(family, ORIGIN, "slow");
		expect(slow.status).toBe(204);
		await ready();
		const res = await checkIn(family, ORIGIN, "slow");
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Refresh")).toBe("true");
		expect(await res.text()).toBe("");
		expect(await seenOf(PERSON)).not.toBeNull();
	});

	it("answers HX-Refresh when the page showed reading and the sort has begun", async () => {
		await sorting();
		const res = await checkIn(family, ORIGIN, "reading");
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Refresh")).toBe("true");
	});

	it("answers HX-Refresh when the page showed ready and the questions are answered", async () => {
		await ready();
		await writeRecord({
			strokes: { bank: TODAY, pay: TODAY, bills: TODAY, budgets: TODAY },
			budgets: {},
		});
		const res = await checkIn(family, ORIGIN, "ready");
		expect(res.status).toBe(200);
		expect(res.headers.get("HX-Refresh")).toBe("true");
	});

	it("answers HX-Refresh when the setup is done and no longer drawn", async () => {
		await reading();
		await writeRecord({
			strokes: {
				bank: "2026-10-13",
				pay: "2026-10-13",
				bills: "2026-10-13",
				budgets: "2026-10-13",
				count: "2026-10-01",
			},
			budgets: {},
		});
		const res = await checkIn(family, ORIGIN, "reading");
		expect(res.headers.get("HX-Refresh")).toBe("true");
	});

	it("answers 204 while the questions are still open and the page shows ready", async () => {
		await ready();
		const res = await checkIn(family, ORIGIN, "ready");
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Refresh")).toBeNull();
	});

	it("never answers HX-Refresh to the questions page's check-in, which sends no step", async () => {
		await ready();
		const open = await checkIn(family, ORIGIN);
		expect(open.status).toBe(204);
		expect(open.headers.get("HX-Refresh")).toBeNull();
		await writeRecord({
			strokes: { bank: TODAY, pay: TODAY, bills: TODAY, budgets: TODAY },
			budgets: {},
		});
		const answered = await checkIn(family, ORIGIN);
		expect(answered.status).toBe(204);
		expect(answered.headers.get("HX-Refresh")).toBeNull();
	});

	it("treats a step that is not one of the four as no step", async () => {
		await ready();
		const res = await checkIn(family, ORIGIN, "nonsense");
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Refresh")).toBeNull();
	});

	it("answers 204 in the demo, whatever step it shows", async () => {
		await ready();
		const res = await checkIn(demo, ORIGIN, "reading");
		expect(res.status).toBe(204);
		expect(res.headers.get("HX-Refresh")).toBeNull();
	});
});
