import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiSwitches } from "../src/db/ai-switches";
import { readFirstTally } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { runReadyEmail } from "../src/first-tally/ready-email";
import { PUSH_RELEASE_SQL, runReadyPush } from "../src/first-tally/ready-push";
import handler from "../src/index";

// The ready push (decision 149, spec §8.8): once a new family's first questions are open and nobody has answered one, each
// person whose page has not checked in for two minutes gets one push on each device they turned notifications on for. The
// email follows at ten minutes (ready-email.test.ts), and a person emailed meanwhile is not pushed. A push that can't be sent
// is counted and never stops the email.

const STROKE_ONE = "2026-10-13";
const DANA = "dana@example.com";
const RILEY = "riley@example.com";
const PHONE = "https://push.example.test/send/dana-phone";
const LAPTOP = "https://push.example.test/send/dana-laptop";
const SPARE = "https://push.example.test/send/riley-phone";
const NEW_DEVICE = "https://push.example.test/send/dana-new";

// RFC 8291's receiver key and auth secret, and RFC 8292's VAPID pair from Appendix A: valid P-256 keys, so the push encrypts
// and signs for real and only the push service is faked.
const UA_PUBLIC =
	"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const AS_PUBLIC =
	"BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";

const scheduledWith = handler as unknown as {
	scheduled(controller: { cron: string }, env: unknown): Promise<unknown>;
};

/** The production environment with the VAPID keys set, Resend on and Cloudflare's email off. */
const pushing = (extra: Record<string, unknown> = {}) =>
	({
		...env,
		DEMO: "false",
		RESEND_API_KEY: "test-key",
		EMAIL: undefined,
		VAPID_PUBLIC_KEY: AS_PUBLIC,
		VAPID_PRIVATE_KEY: AS_PRIVATE,
		...extra,
	}) as never;

/**
 * The push services and Resend, faked. Each push endpoint answers what `answer` says (201 by default; "throw" for a fetch that
 * fails). `beforeAnswer` runs before a push endpoint answers, so a test can change the records meanwhile.
 */
function fakeFetch({
	answer = () => 201,
	beforeAnswer,
	resendStatus = 200,
}: {
	answer?: (endpoint: string) => number | "throw";
	beforeAnswer?: (endpoint: string) => Promise<void>;
	resendStatus?: number;
} = {}) {
	const pushed: string[] = [];
	const resent: string[] = [];
	const fetchImpl = vi.fn(
		async (url: RequestInfo | URL, init?: RequestInit) => {
			const target = String(url);
			if (target.startsWith("https://api.resend.com")) {
				resent.push((JSON.parse(String(init?.body)) as { to: string }).to);
				return new Response("{}", { status: resendStatus });
			}
			pushed.push(target);
			await beforeAnswer?.(target);
			const status = answer(target);
			if (status === "throw") throw new TypeError("network down");
			return new Response(null, { status });
		},
	);
	return { fetchImpl, pushed, resent };
}

/** Writes the first week's record as given (the whole JSON), replacing any record before it. */
async function writeRecord(record: unknown) {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
		env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
		).bind(JSON.stringify(record)),
	]);
}

/** One connected bank with its history in (unless told otherwise), and its account. */
async function addBank(id: number, name: string, { history = true } = {}) {
	await env.DB.prepare(
		"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by, plaid_item_id, last_synced_at, history_complete_at, disconnected_at) VALUES (?, X'', ?, ?, ?, ?, ?, NULL)",
	)
		.bind(
			id,
			name,
			DANA,
			`item-${id}`,
			"2026-10-13 09:00:00",
			history ? "2026-10-13 09:00:00" : null,
		)
		.run();
	await env.DB.prepare(
		"INSERT INTO accounts (plaid_item_id, name, mask, type, balance_cents) VALUES (?, 'Checking', '4521', 'depository', 0)",
	)
		.bind(id)
		.run();
}

/** A member whose page last checked in `seen` (a SQLite modifier, or null for never), and who may be removed. */
async function addMember(
	email: string,
	{
		seen = "-180 seconds",
		removed = false,
	}: { seen?: string | null; removed?: boolean } = {},
) {
	await env.DB.prepare(
		"INSERT INTO household_members (email, last_seen_at, home_seen_at, removed_at) VALUES (?, datetime('now'), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END, ?)",
	)
		.bind(email, seen, seen ?? "", removed ? "2026-10-01 00:00:00" : null)
		.run();
}

/** One device a person turned notifications on for. */
async function addDevice(email: string, endpoint: string) {
	await env.DB.prepare(
		"INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)",
	)
		.bind(email, endpoint, UA_PUBLIC, AUTH)
		.run();
}

/** Empties the banks, members, devices and the first week's and the switch's rows. */
async function clearHousehold() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM push_subscriptions"),
		env.DB.prepare("DELETE FROM household_members"),
		env.DB.prepare(
			"DELETE FROM household_settings WHERE key IN ('bank_sign_in_emails', 'first_tally')",
		),
	]);
}

/** A family whose questions are open: one bank with its history in, and stroke one drawn the day before. */
async function openHousehold(
	record: unknown = { strokes: { bank: STROKE_ONE }, budgets: {} },
) {
	await clearHousehold();
	await addBank(1, "Chase");
	await saveAiSwitches(env.DB, { categories: false, income: false });
	await writeRecord(record);
}

/** The database with every statement that contains `needle` throwing, so one step of a run fails and the rest still runs. */
function failingOn(needle: string): D1Database {
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "prepare")
				return (sql: string) => {
					if (sql.includes(needle)) throw new Error("boom");
					return target.prepare(sql);
				};
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The database, counting each statement it prepares, so a test can see that a run read nothing. */
function countingDb(counter: { statements: number }): D1Database {
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "prepare")
				return (sql: string) => {
					counter.statements += 1;
					return target.prepare(sql);
				};
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** The database, recording each statement it prepares, trimmed and in order, so a test can see what a run reads and writes when. */
function recordingDb(statements: string[]): D1Database {
	return new Proxy(env.DB, {
		get(target, prop) {
			if (prop === "prepare")
				return (sql: string) => {
					statements.push(sql.trim());
					return target.prepare(sql);
				};
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A statement that claims a push, or releases one: an update of the record's readyPushedTo list. */
const isPushClaimOrRelease = (sql: string) =>
	sql.startsWith("UPDATE household_settings") && sql.includes("readyPushedTo");

/** A statement that reads. */
const isRead = (sql: string) => sql.startsWith("SELECT");

/** The address list the push has claimed, as the record holds it. */
const pushedList = async () => (await readFirstTally(env.DB))?.readyPushedTo;

/**
 * The key a kept ready email is stored under: the SHA-256 in hex of the lower-cased address (ready-email.tsx). Computed here
 * from the spec, not through the module, so a wrong key in the module cannot pass.
 */
async function heldKeyOf(email: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(email.toLowerCase()),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** A kept ready email, as the record stores it (decisions 146 and 147). */
const keptEmail = (text: string) => ({
	mail: {
		subject: "Three questions to finish setting up",
		html: `<p>${text}</p>`,
		text,
	},
	at: "2026-10-13T09:00:00Z",
});

/** The devices still stored for an address, by endpoint. */
async function devicesOf(email: string) {
	const { results } = await env.DB.prepare(
		"SELECT endpoint FROM push_subscriptions WHERE member_email = ? ORDER BY id",
	)
		.bind(email)
		.all<{ endpoint: string }>();
	return results.map((row) => row.endpoint);
}

beforeEach(async () => resetDemo(env.DB, "2026-10-07"));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("the ready push: who gets it, and when", () => {
	it("pushes once to each device of a person away for two minutes, and to nobody else", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addMember(RILEY, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(DANA, LAPTOP);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([PHONE, LAPTOP]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("pushes to a person who has never checked in on a first-week page", async () => {
		await openHousehold();
		await addMember(DANA, { seen: null });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([PHONE]);
	});

	it("does not push to a person who checked in within the last two minutes", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-60 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([]);
		expect(await pushedList()).toBeUndefined();
	});

	it("does not push to a person already emailed", async () => {
		await openHousehold({
			strokes: { bank: STROKE_ONE },
			budgets: {},
			readyEmailedTo: [DANA],
		});
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([]);
	});

	it("does not push to a person whose kept ready email may already have reached them (decisions 146 and 147)", async () => {
		// The email's first try got no answer, so the address is off readyEmailedTo but its try is kept under its own hash.
		await openHousehold({
			strokes: { bank: STROKE_ONE },
			budgets: {},
			heldReadyEmail: { [await heldKeyOf(DANA)]: keptEmail("kept") },
		});
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([]);
		expect(await pushedList()).toBeUndefined();
	});

	it("a kept ready email for someone else does not stop this person's push", async () => {
		await openHousehold({
			strokes: { bank: STROKE_ONE },
			budgets: {},
			heldReadyEmail: { [await heldKeyOf(RILEY)]: keptEmail("kept") },
		});
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([PHONE]);
	});

	it("does not push to a removed person, even with devices still stored", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds", removed: true });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([]);
	});

	it("pushes once: a second run finds the person already claimed", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([PHONE]);
	});

	it("sends nothing while a question is answered", async () => {
		await openHousehold({
			strokes: { bank: STROKE_ONE, pay: STROKE_ONE },
			budgets: {},
		});
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([]);
	});

	it("sends nothing while a bank's history is still loading", async () => {
		await clearHousehold();
		await addBank(1, "Chase", { history: false });
		await writeRecord({ strokes: { bank: STROKE_ONE }, budgets: {} });
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([]);
	});

	it("reads nothing and sends nothing with no keys, or in the demo", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed } = fakeFetch();
		const counter = { statements: 0 };
		await runReadyPush(
			pushing({
				VAPID_PUBLIC_KEY: undefined,
				VAPID_PRIVATE_KEY: undefined,
				DB: countingDb(counter),
			}),
			{ fetchImpl },
		);
		await runReadyPush(pushing({ DEMO: "true", DB: countingDb(counter) }), {
			fetchImpl,
		});
		expect(pushed).toEqual([]);
		expect(counter.statements).toBe(0);
	});
});

describe("the ready push: how each answer counts", () => {
	it("deletes a device that answered 410, by its row, and keeps a device added meanwhile", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(DANA, LAPTOP);
		const { fetchImpl } = fakeFetch({
			answer: (endpoint) => (endpoint === PHONE ? 410 : 201),
			beforeAnswer: async (endpoint) => {
				// A new subscription for the same person lands while the push to the old device is out.
				if (endpoint === PHONE) await addDevice(DANA, NEW_DEVICE);
			},
		});
		await runReadyPush(pushing(), { fetchImpl });
		expect(await devicesOf(DANA)).toEqual([LAPTOP, NEW_DEVICE]);
	});

	it("deletes a device that answered 404 too", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl } = fakeFetch({ answer: () => 404 });
		await runReadyPush(pushing(), { fetchImpl });
		expect(await devicesOf(DANA)).toEqual([]);
	});

	it("releases the claim when every device gave a transient answer, so the next minute tries again", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(DANA, LAPTOP);
		await addDevice(DANA, SPARE);
		const first = fakeFetch({
			answer: (endpoint) =>
				endpoint === PHONE ? "throw" : endpoint === LAPTOP ? 429 : 503,
		});
		await runReadyPush(pushing(), { fetchImpl: first.fetchImpl });
		expect(first.pushed).toHaveLength(3);
		expect(await pushedList()).toEqual([]);
		const second = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl: second.fetchImpl });
		expect(second.pushed).toEqual([PHONE, LAPTOP, SPARE]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("keeps the claim on a permanent 403, so the next run does not send", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const first = fakeFetch({ answer: () => 403 });
		await runReadyPush(pushing(), { fetchImpl: first.fetchImpl });
		expect(await pushedList()).toEqual([DANA]);
		const second = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl: second.fetchImpl });
		expect(second.pushed).toEqual([]);
	});

	it("a throwing device does not stop the others, and a success keeps the claim", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(DANA, LAPTOP);
		const { fetchImpl, pushed } = fakeFetch({
			answer: (endpoint) => (endpoint === PHONE ? "throw" : 201),
		});
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([PHONE, LAPTOP]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("a device that throws alone releases the claim, so the next minute is not stuck", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const first = fakeFetch({ answer: () => "throw" });
		await runReadyPush(pushing(), { fetchImpl: first.fetchImpl });
		expect(await pushedList()).toEqual([]);
		const second = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl: second.fetchImpl });
		expect(second.pushed).toEqual([PHONE]);
	});

	it("a database error on one device's delete leaves the other devices sending", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(DANA, LAPTOP);
		const { fetchImpl, pushed } = fakeFetch({
			answer: (endpoint) => (endpoint === PHONE ? 410 : 201),
		});
		await runReadyPush(
			pushing({ DB: failingOn("DELETE FROM push_subscriptions") }),
			{ fetchImpl },
		);
		expect(pushed).toEqual([PHONE, LAPTOP]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("logs counts and the status only, never an endpoint", async () => {
		const logs: unknown[][] = [];
		vi.spyOn(console, "log").mockImplementation((...args) => {
			logs.push(args);
		});
		vi.spyOn(console, "error").mockImplementation((...args) => {
			logs.push(args);
		});
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(DANA, LAPTOP);
		const { fetchImpl } = fakeFetch({
			answer: (endpoint) => (endpoint === PHONE ? 410 : 201),
		});
		await runReadyPush(pushing(), { fetchImpl });
		const text = JSON.stringify(logs);
		expect(text).toContain("ready push: 1 sent, 1 failed");
		expect(text).toContain("push 410");
		expect(text).not.toContain("push.example.test");
		expect(text).not.toContain(DANA);
	});
});

describe("the ready push: every read comes before a claim", () => {
	it("reads every device in one query before it claims anyone, and reads the gate again before each claim", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addMember(RILEY, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(RILEY, SPARE);
		const statements: string[] = [];
		const { fetchImpl, pushed } = fakeFetch();
		await runReadyPush(pushing({ DB: recordingDb(statements) }), {
			fetchImpl,
		});
		expect(pushed).toEqual([PHONE, SPARE]);
		const isDeviceRead = (sql: string) =>
			isRead(sql) && sql.includes("push_subscriptions");
		expect(statements.filter(isDeviceRead)).toHaveLength(1);
		const deviceRead = statements.findIndex(isDeviceRead);
		const claims = statements.flatMap((sql, index) =>
			isPushClaimOrRelease(sql) ? [index] : [],
		);
		expect(claims).toHaveLength(2);
		const [firstClaim, secondClaim] = claims as [number, number];
		expect(deviceRead).toBeLessThan(firstClaim);
		// The gate (the record, the banks and the sort count) is read again between the two claims ...
		expect(
			statements.slice(firstClaim + 1, secondClaim).filter(isRead).length,
		).toBeGreaterThan(0);
		// ... and nothing is read after the last claim.
		expect(statements.slice(secondClaim).filter(isRead)).toEqual([]);
	});

	it("stops the loop when the gate closes after the first push: the second person is neither claimed nor pushed", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addMember(RILEY, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(RILEY, SPARE);
		// A new bank is linked while Dana's push is out, and its history is still loading: the gate closes after her push.
		const { fetchImpl, pushed } = fakeFetch({
			beforeAnswer: async (endpoint) => {
				if (endpoint === PHONE) await addBank(2, "Amex", { history: false });
			},
		});
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([PHONE]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("stops the loop when a question is answered after the first push", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addMember(RILEY, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(RILEY, SPARE);
		const { fetchImpl, pushed } = fakeFetch({
			beforeAnswer: async (endpoint) => {
				if (endpoint !== PHONE) return;
				await env.DB.prepare(
					`UPDATE household_settings SET value = json_set(value, '$.strokes.pay', ?) WHERE key = 'first_tally'`,
				)
					.bind(STROKE_ONE)
					.run();
			},
		});
		await runReadyPush(pushing(), { fetchImpl });
		expect(pushed).toEqual([PHONE]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("a failed device read claims nobody, so the next minute pushes", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const first = fakeFetch();
		await expect(
			runReadyPush(pushing({ DB: failingOn("FROM push_subscriptions s") }), {
				fetchImpl: first.fetchImpl,
			}),
		).rejects.toThrow("boom");
		expect(first.pushed).toEqual([]);
		expect(await pushedList()).toBeUndefined();
		const second = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl: second.fetchImpl });
		expect(second.pushed).toEqual([PHONE]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("does not throw when the release fails, and still tries the next person", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		await openHousehold();
		await addMember(DANA, { seen: "-180 seconds" });
		await addMember(RILEY, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		await addDevice(RILEY, SPARE);
		const { fetchImpl, pushed } = fakeFetch({
			answer: (endpoint) => (endpoint === PHONE ? 503 : 201),
		});
		await expect(
			runReadyPush(pushing({ DB: failingOn(PUSH_RELEASE_SQL) }), {
				fetchImpl,
			}),
		).resolves.toBeUndefined();
		expect(pushed).toEqual([PHONE, SPARE]);
	});
});

describe("the ready email still goes", () => {
	it("a failed release leaves that person's one claim, and the email still goes at ten minutes", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		await openHousehold();
		await addMember(DANA, { seen: "-11 minutes" });
		await addDevice(DANA, PHONE);
		const push = fakeFetch({ answer: () => 503 });
		await runReadyPush(pushing({ DB: failingOn(PUSH_RELEASE_SQL) }), {
			fetchImpl: push.fetchImpl,
		});
		expect(await pushedList()).toEqual([DANA]);
		const email = fakeFetch();
		await runReadyEmail(pushing(), email.fetchImpl);
		expect(email.resent).toEqual([DANA]);
	});

	it("sends the email at ten minutes to a person whose push went", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-11 minutes" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed, resent } = fakeFetch();
		await runReadyPush(pushing(), { fetchImpl });
		await runReadyEmail(pushing(), fetchImpl);
		expect(pushed).toEqual([PHONE]);
		expect(resent).toEqual([DANA]);
	});

	it("leaves a kept ready email untouched when a push releases its claim", async () => {
		// The push claims Dana first (no try is kept yet). While Dana's push is out, the email's own try is kept under Dana's hash
		// (a concurrent run), and Riley's kept try is already there. A transient answer then releases Dana's push claim, which
		// must not touch either kept try: only RELEASE_SQL rewrites heldReadyEmail, and that would wipe Dana's.
		const rileysKey = await heldKeyOf(RILEY);
		const held = {
			[await heldKeyOf(DANA)]: keptEmail("kept for dana"),
			[rileysKey]: keptEmail("kept for riley"),
		};
		await openHousehold({
			strokes: { bank: STROKE_ONE },
			budgets: {},
			heldReadyEmail: { [rileysKey]: held[rileysKey] },
		});
		await addMember(DANA, { seen: "-180 seconds" });
		await addDevice(DANA, PHONE);
		const { fetchImpl } = fakeFetch({
			answer: () => 503,
			beforeAnswer: async () => {
				await env.DB.prepare(
					"UPDATE household_settings SET value = json_set(value, '$.heldReadyEmail', json(?)) WHERE key = 'first_tally'",
				)
					.bind(JSON.stringify(held))
					.run();
			},
		});
		await runReadyPush(pushing(), { fetchImpl });
		expect(await pushedList()).toEqual([]);
		expect((await readFirstTally(env.DB))?.heldReadyEmail).toEqual(held);
	});
});

describe("the scheduled run: a push never stops the email", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it.each([
		["the minute run", "* * * * *"],
		["the 10:00 backstop", "0 10 * * *"],
	])("runs the push before the email on %s", async (_name, cron) => {
		await openHousehold();
		await addMember(DANA, { seen: "-11 minutes" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, resent } = fakeFetch();
		vi.stubGlobal("fetch", fetchImpl);
		await scheduledWith.scheduled({ cron }, pushing());
		expect(resent).toEqual([DANA]);
		expect(await pushedList()).toEqual([DANA]);
	});

	it("still sends the email when the push's database read fails", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-11 minutes" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, resent } = fakeFetch();
		vi.stubGlobal("fetch", fetchImpl);
		await scheduledWith.scheduled(
			{ cron: "* * * * *" },
			pushing({ DB: failingOn("push_subscriptions") }),
		);
		expect(resent).toEqual([DANA]);
	});

	it("a malformed private key means no push is drawn or sent, and the email still goes", async () => {
		await openHousehold();
		await addMember(DANA, { seen: "-11 minutes" });
		await addDevice(DANA, PHONE);
		const { fetchImpl, pushed, resent } = fakeFetch();
		vi.stubGlobal("fetch", fetchImpl);
		await scheduledWith.scheduled(
			{ cron: "* * * * *" },
			pushing({ VAPID_PRIVATE_KEY: "not-a-key" }),
		);
		expect(pushed).toEqual([]);
		expect(resent).toEqual([DANA]);
	});
});
