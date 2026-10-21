import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { saveAiSwitches } from "../src/db/ai-switches";
import { markStroke, readFirstTally } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import {
	CLAIM_SQL,
	readLine,
	readyEmailKey,
	renderReadyEmail,
	runReadyEmail,
} from "../src/first-tally/ready-email";
import handler from "../src/index";
import type { Mail } from "../src/reconnect/deliver";

// The ready email (P140, decision 134, decision 146, spec §8.8): one email per person, sent by the minute run once a new
// family's first questions are open (the 10:00 run is the backstop), and never again to an address it has reached. A person
// whose page has checked in within the last 10 minutes is not sent to yet: someone still watching sees the questions there.

const STROKE_ONE = "2026-10-13";
const SUBJECT = "Three questions to finish setting up";
const NEXT =
	"Now check three things: your pay, your bills and your budgets. About three minutes.";
const FOOT = "Tally sends this once, to everyone in your family who uses it.";
const LINK = "https://tally.thesuperhuman.us/first-page";
const DANA = "dana@example.com";
const RILEY = "riley@example.com";

const scheduledWith = handler as unknown as {
	scheduled(controller: { cron: string }, env: unknown): Promise<unknown>;
};

type Sent = { to: string; subject: string; html: string; text: string };

/** The Idempotency-Key a request carried, or null when it carried none. */
const keyOf = (init: RequestInit | undefined) =>
	(init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ??
	null;

/** Resend's fake: answers `status` and records each request's recipient, words and Idempotency-Key. */
function resendFake(status = 200) {
	const sent: Sent[] = [];
	const keys: (string | null)[] = [];
	const fetchImpl = vi.fn(
		async (_url: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Sent;
			sent.push({
				to: body.to,
				subject: body.subject,
				html: body.html,
				text: body.text,
			});
			keys.push(keyOf(init));
			return new Response("{}", { status });
		},
	);
	return { fetchImpl, sent, keys };
}

/**
 * The key a ready email carries for an address and its words, written out from its definition (decision 146): SHA-256 of the
 * JSON of the lower-cased address, the subject, the HTML and the text.
 */
async function keyFor(address: string, mail: Mail) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([
				address.toLowerCase(),
				mail.subject,
				mail.html,
				mail.text,
			]),
		),
	);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `ready-email-${hex}`;
}

/** The first email Resend was sent, which a test takes its words from. */
function firstMail(sent: Sent[]): Mail {
	const mail = sent[0];
	if (!mail) throw new Error("Resend was sent no email");
	return mail;
}

/** The production environment: Resend on, Cloudflare's email off unless a test gives it. */
const production = (extra: Record<string, unknown> = {}) =>
	({
		...env,
		DEMO: "false",
		RESEND_API_KEY: "test-key",
		EMAIL: undefined,
		...extra,
	}) as never;

/** Writes the first week's record as given (the whole JSON), replacing any record before it. */
async function writeRecord(record: unknown) {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM household_settings WHERE key = 'first_tally'"),
		env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('first_tally', ?)",
		).bind(JSON.stringify(record)),
	]);
}

/** One connected bank: its sync marks (both set unless told otherwise), and `disconnected` keeps its history. */
async function addBank(
	id: number,
	name: string,
	{
		synced = true,
		history = true,
		disconnected = false,
	}: { synced?: boolean; history?: boolean; disconnected?: boolean } = {},
): Promise<number> {
	await env.DB.prepare(
		"INSERT INTO plaid_items (id, access_token_encrypted, institution_name, linked_by, plaid_item_id, last_synced_at, history_complete_at, disconnected_at) VALUES (?, X'', ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			name,
			DANA,
			`item-${id}`,
			synced ? "2026-10-13 09:00:00" : null,
			history ? "2026-10-13 09:00:00" : null,
			disconnected ? "2026-10-13 10:00:00" : null,
		)
		.run();
	const account = await env.DB.prepare(
		"INSERT INTO accounts (plaid_item_id, name, mask, type, balance_cents) VALUES (?, 'Checking', '4521', 'depository', 0)",
	)
		.bind(id)
		.run();
	return Number(account.meta.last_row_id);
}

/** `count` transactions with Plaid's ids on one account, each a plain outgoing purchase. */
async function addTransactions(accountId: number, count: number) {
	if (count === 0) return;
	await env.DB.prepare(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name)
		SELECT 'txn-' || ?2 || '-' || i, ?2, '2026-10-01', -100, 'SHOP ' || i FROM n`,
	)
		.bind(count, accountId)
		.run();
}

async function addMember(
	email: string,
	{
		seen = "now",
		removed = false,
	}: { seen?: "now" | "2020"; removed?: boolean } = {},
) {
	await env.DB.prepare(
		"INSERT INTO household_members (email, last_seen_at, removed_at) VALUES (?, ?, ?)",
	)
		.bind(
			email,
			seen === "now"
				? new Date().toISOString().slice(0, 19).replace("T", " ")
				: "2020-01-01 00:00:00",
			removed ? "2026-10-01 00:00:00" : null,
		)
		.run();
}

/** Empties the banks, their accounts and transactions, the members, and the first week's and the switch's rows. */
async function clearHousehold() {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM household_members"),
		env.DB.prepare(
			"DELETE FROM household_settings WHERE key IN ('bank_sign_in_emails', 'first_tally')",
		),
	]);
}

/**
 * A family whose questions are open: one Chase bank with its history in and no transactions, stroke one drawn
 * the day before, and the given members. The Jev switches are off, so no transaction waits for an answer unless a test
 * turns them on. Returns the bank's account id.
 */
async function openHousehold({
	members = [DANA],
	record = { strokes: { bank: STROKE_ONE }, budgets: {} },
}: {
	members?: string[];
	record?: unknown;
} = {}): Promise<number> {
	await clearHousehold();
	const accountId = await addBank(1, "Chase");
	await saveAiSwitches(env.DB, { categories: false, income: false });
	await writeRecord(record);
	for (const email of members) await addMember(email);
	return accountId;
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

const storedList = async () => (await readFirstTally(env.DB))?.readyEmailedTo;

beforeEach(async () => resetDemo(env.DB, "2026-10-07"));

describe("the ready email: who gets it, and when", () => {
	it("sends each household address the email once, with the words, and records each address as reached", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([DANA, RILEY]);
		for (const mail of sent) {
			expect(mail.subject).toBe(SUBJECT);
			expect(mail.html).toContain(`>${SUBJECT}<`);
			expect(mail.html).toContain(
				"Tally has read your last 90 days from Chase.",
			);
			expect(mail.html).toContain(NEXT);
			expect(mail.html).toContain(`href="${LINK}"`);
			expect(mail.html).toContain("Finish setting up");
			expect(mail.html).toContain(FOOT);
			expect(mail.text).toContain(SUBJECT);
			expect(mail.text).toContain(
				"Tally has read your last 90 days from Chase.",
			);
			expect(mail.text).toContain(NEXT);
			expect(mail.text).toContain(`Finish setting up: ${LINK}`);
			expect(mail.text).toContain(FOOT);
		}
		expect(await storedList()).toEqual([DANA, RILEY]);
	});

	it("stores the first address as a list of one on a record that had no list", async () => {
		await openHousehold({ members: [DANA] });
		const before = await readFirstTally(env.DB);
		expect(before?.readyEmailedTo).toBeUndefined();
		await runReadyEmail(production(), resendFake().fetchImpl);
		expect(await storedList()).toEqual([DANA]);
	});

	it("claims each address before its email is sent, so a send that is underway already shows as reached", async () => {
		await openHousehold({ members: [DANA] });
		const reachedAtSend: boolean[] = [];
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, init?: RequestInit) => {
				const to = (JSON.parse(String(init?.body)) as Sent).to;
				reachedAtSend.push(
					((await readFirstTally(env.DB))?.readyEmailedTo ?? []).includes(to),
				);
				return new Response("{}", { status: 200 });
			},
		);
		await runReadyEmail(production(), fetchImpl);
		expect(reachedAtSend).toEqual([true]);
	});

	it("does not send while the questions are shut: the history is not in yet", async () => {
		await openHousehold();
		await env.DB.prepare(
			"UPDATE plaid_items SET history_complete_at = NULL",
		).run();
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent).toEqual([]);
		expect(await storedList()).toBeUndefined();
	});

	it("sends on stroke one's own day once every bank's history is in and nothing waits", async () => {
		await openHousehold({
			members: [DANA],
			record: { strokes: { bank: todayIn(DEFAULT_TIME_ZONE) }, budgets: {} },
		});
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
	});

	it("does not send with no connected bank", async () => {
		await openHousehold();
		await env.DB.prepare(
			"UPDATE plaid_items SET disconnected_at = datetime('now')",
		).run();
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent).toEqual([]);
	});

	it("does not send while a transaction still waits for Jev's answer", async () => {
		const accountId = await openHousehold();
		await saveAiSwitches(env.DB, { categories: true });
		await env.DB.prepare(
			"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name) VALUES ('waiting', ?, '2026-10-01', -100, 'SHOP')",
		)
			.bind(accountId)
			.run();
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent).toEqual([]);
	});

	it.each(["pay", "bills", "budgets"] as const)(
		"does not send once the %s question is answered",
		async (stroke) => {
			await openHousehold({
				record: {
					strokes: { bank: STROKE_ONE, [stroke]: "2026-10-14" },
					budgets: {},
				},
			});
			const { fetchImpl, sent } = resendFake();
			await runReadyEmail(production(), fetchImpl);
			expect(sent).toEqual([]);
		},
	);

	it("does not send to a household set up before this shipped (migration 0057 draws every stroke with no day)", async () => {
		await openHousehold({
			record: {
				strokes: {
					bank: null,
					pay: null,
					bills: null,
					budgets: null,
					count: null,
				},
				budgets: {},
			},
		});
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent).toEqual([]);
	});

	it("does not send in the demo", async () => {
		await openHousehold();
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production({ DEMO: "true" }), fetchImpl);
		expect(sent).toEqual([]);
	});

	it("does not send to an empty household list", async () => {
		await openHousehold({ members: [] });
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent).toEqual([]);
		expect(await storedList()).toBeUndefined();
	});

	it("is not stopped by the bank sign-in emails switch", async () => {
		await openHousehold();
		await env.DB.prepare(
			"INSERT INTO household_settings (key, value) VALUES ('bank_sign_in_emails', 'off')",
		).run();
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
	});
});

describe("the ready email: who is still there (decision 146)", () => {
	/** Sets a person's last check-in to a SQLite time modifier from now, such as '-30 seconds'. */
	const checkedInAt = (email: string, when: string) =>
		env.DB.prepare(
			"UPDATE household_members SET home_seen_at = datetime('now', ?) WHERE email = ?",
		)
			.bind(when, email)
			.run();

	/** A database whose prepared statements are counted, so a run's reads can be counted. */
	function countingDb() {
		const statements: string[] = [];
		const db = new Proxy(env.DB, {
			get(target, prop) {
				if (prop === "prepare")
					return (sql: string) => {
						statements.push(sql);
						return target.prepare(sql);
					};
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return { db, statements };
	}

	it.each(["-30 seconds", "-9 minutes"])(
		"gives no email to a person whose page checked in %s, and tries them on a later minute",
		async (when) => {
			await openHousehold({ members: [DANA] });
			await checkedInAt(DANA, when);
			const first = resendFake();
			await runReadyEmail(production(), first.fetchImpl);
			expect(first.sent).toEqual([]);
			expect(await storedList()).toBeUndefined();
			await checkedInAt(DANA, "-11 minutes");
			const later = resendFake();
			await runReadyEmail(production(), later.fetchImpl);
			expect(later.sent.map((mail) => mail.to)).toEqual([DANA]);
		},
	);

	it("gives the email to a person whose page last checked in 11 minutes ago", async () => {
		await openHousehold({ members: [DANA] });
		await checkedInAt(DANA, "-11 minutes");
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
	});

	it("of two people, emails only the one who has left", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		await checkedInAt(DANA, "-30 seconds");
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([RILEY]);
		expect(await storedList()).toEqual([RILEY]);
	});

	it("gives the email to a person whose page has never checked in", async () => {
		await openHousehold({ members: [DANA] });
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
	});

	it("sends nothing once a question is answered, even to a person who has left", async () => {
		await openHousehold({ members: [DANA] });
		await writeRecord({
			strokes: { bank: STROKE_ONE, pay: STROKE_ONE },
			budgets: {},
		});
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent).toEqual([]);
	});

	it("nothing is logged when no address is claimed", async () => {
		await openHousehold({ members: [DANA] });
		await checkedInAt(DANA, "-30 seconds");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await runReadyEmail(production(), resendFake().fetchImpl);
		expect(log).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		log.mockRestore();
		error.mockRestore();
	});

	it("a set-up household costs one read and sends nothing", async () => {
		await openHousehold({ members: [DANA] });
		await writeRecord({
			strokes: {
				bank: STROKE_ONE,
				pay: STROKE_ONE,
				bills: STROKE_ONE,
				budgets: STROKE_ONE,
				count: STROKE_ONE,
			},
			budgets: {},
		});
		const { db, statements } = countingDb();
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production({ DB: db }), fetchImpl);
		expect(statements).toHaveLength(1);
		expect(sent).toEqual([]);
	});
});

describe("the ready email: recipients", () => {
	it("never sends to a removed member, or to one not seen in 90 days", async () => {
		await openHousehold({ members: [] });
		await addMember(DANA);
		await addMember(RILEY, { removed: true });
		await addMember("casey@example.com", { seen: "2020" });
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
	});

	it("never sends again to an address already reached, even after a take-back reopens the questions", async () => {
		await openHousehold({
			members: [DANA, RILEY],
			record: {
				strokes: { bank: STROKE_ONE },
				budgets: {},
				readyEmailedTo: [DANA],
			},
		});
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent.map((mail) => mail.to)).toEqual([RILEY]);
	});

	it("sends once on a morning: a second run that morning sends nothing", async () => {
		await openHousehold();
		const first = resendFake();
		await runReadyEmail(production(), first.fetchImpl);
		const second = resendFake();
		await runReadyEmail(production(), second.fetchImpl);
		expect(first.sent.map((mail) => mail.to)).toEqual([DANA]);
		expect(second.sent).toEqual([]);
	});
});

describe("the ready email: a run that overlaps another", () => {
	it("does not send an address twice when a second run has read the list before the first claimed it", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const second = resendFake();
		const first = resendFake();
		// While the first run sends to Dana, a second run reads the list (Dana is claimed, Riley is not) and sends to Riley.
		// The first run then reaches Riley from its own, older list: the claim must refuse her, so she is sent it once.
		const firstFetch = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				const to = (JSON.parse(String(init?.body)) as Sent).to;
				if (to === DANA) await runReadyEmail(production(), second.fetchImpl);
				return first.fetchImpl(url, init);
			},
		);
		await runReadyEmail(production(), firstFetch);
		expect(second.sent.map((mail) => mail.to)).toEqual([RILEY]);
		expect(first.sent.map((mail) => mail.to)).toEqual([DANA]);
		expect(await storedList()).toEqual([DANA, RILEY]);
	});
});

describe("the ready email: a question answered during a run", () => {
	it("sends nothing more once a question is answered: the address being sent to is kept, and the next is not sent", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const { fetchImpl, sent } = resendFake();
		// While the email to Dana is delivered, the family answers the pay question. Riley is then never sent to, nor reached.
		const answeredDuringDana = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				const to = (JSON.parse(String(init?.body)) as Sent).to;
				if (to === DANA) await markStroke(env.DB, "pay", "2026-10-14");
				return fetchImpl(url, init);
			},
		);
		await runReadyEmail(production(), answeredDuringDana);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
		expect(await storedList()).toEqual([DANA]);
	});

	it("the claim changes one row while the questions are open", async () => {
		await openHousehold();
		const claim = await env.DB.prepare(CLAIM_SQL).bind(DANA).run();
		expect(claim.meta.changes).toBe(1);
		expect(await storedList()).toEqual([DANA]);
	});

	it.each(["pay", "bills", "budgets"] as const)(
		"the claim changes no row once the %s question is answered",
		async (stroke) => {
			await openHousehold({
				record: {
					strokes: { bank: STROKE_ONE, [stroke]: "2026-10-14" },
					budgets: {},
				},
			});
			const claim = await env.DB.prepare(CLAIM_SQL).bind(DANA).run();
			expect(claim.meta.changes).toBe(0);
			expect(await storedList()).toBeUndefined();
		},
	);

	it("the claim changes no row for a question drawn with no day (a migrated record's null)", async () => {
		await openHousehold({
			record: {
				strokes: { bank: STROKE_ONE, pay: null },
				budgets: {},
			},
		});
		const claim = await env.DB.prepare(CLAIM_SQL).bind(DANA).run();
		expect(claim.meta.changes).toBe(0);
		expect(await storedList()).toBeUndefined();
	});
});

describe("the ready email: the gate and the members, checked before each address", () => {
	it("stops once a bank is linked whose history is not in yet: the next address is not sent", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const { fetchImpl, sent } = resendFake();
		// While the email to Dana is delivered, a bank is linked and its 90-day history is still loading.
		const linkedDuringDana = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				const to = (JSON.parse(String(init?.body)) as Sent).to;
				if (to === DANA) await addBank(2, "Ally", { history: false });
				return fetchImpl(url, init);
			},
		);
		await runReadyEmail(production(), linkedDuringDana);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
		expect(await storedList()).toEqual([DANA]);
	});

	it("sends the next address the words of the banks as they are then, when a bank is linked with its history in", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const { fetchImpl, sent } = resendFake();
		const linkedDuringDana = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				const to = (JSON.parse(String(init?.body)) as Sent).to;
				if (to === DANA) await addBank(2, "Ally");
				return fetchImpl(url, init);
			},
		);
		await runReadyEmail(production(), linkedDuringDana);
		expect(sent.map((mail) => mail.to)).toEqual([DANA, RILEY]);
		expect(sent[0]?.text).toContain("from Chase.");
		expect(sent[1]?.text).toContain("from Chase and Ally.");
		expect(await storedList()).toEqual([DANA, RILEY]);
	});

	it("never sends to a member removed while an earlier send was waiting, and never records her as reached", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const { fetchImpl, sent } = resendFake();
		// While the email to Dana is delivered, Riley leaves the family in Settings. Her turn is then skipped.
		const removedDuringDana = vi.fn(
			async (url: RequestInfo | URL, init?: RequestInit) => {
				const to = (JSON.parse(String(init?.body)) as Sent).to;
				if (to === DANA)
					await env.DB.prepare(
						"UPDATE household_members SET removed_at = datetime('now') WHERE email = ?",
					)
						.bind(RILEY)
						.run();
				return fetchImpl(url, init);
			},
		);
		await runReadyEmail(production(), removedDuringDana);
		expect(sent.map((mail) => mail.to)).toEqual([DANA]);
		expect(await storedList()).toEqual([DANA]);
	});

	it("the claim changes no row for a member who was removed", async () => {
		await openHousehold({ members: [] });
		await addMember(DANA, { removed: true });
		const claim = await env.DB.prepare(CLAIM_SQL).bind(DANA).run();
		expect(claim.meta.changes).toBe(0);
		expect(await storedList()).toBeUndefined();
	});

	it("the claim changes no row for a member not seen in 90 days", async () => {
		await openHousehold({ members: [] });
		await addMember(DANA, { seen: "2020" });
		const claim = await env.DB.prepare(CLAIM_SQL).bind(DANA).run();
		expect(claim.meta.changes).toBe(0);
		expect(await storedList()).toBeUndefined();
	});
});

describe("the ready email: delivery", () => {
	it("keeps the address when Cloudflare's email delivers after Resend fails", async () => {
		await openHousehold();
		const send = vi.fn(async (_message: Record<string, unknown>) => ({}));
		const { fetchImpl } = resendFake(500);
		await runReadyEmail(production({ EMAIL: { send } }), fetchImpl);
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]?.[0]).toMatchObject({
			to: DANA,
			subject: SUBJECT,
		});
		expect(await storedList()).toEqual([DANA]);
	});

	it("releases the address when neither provider delivers, so the next minute sends it again", async () => {
		await openHousehold();
		const email = {
			send: vi.fn(async () => {
				throw new Error("down");
			}),
		};
		await runReadyEmail(
			production({ EMAIL: email }),
			resendFake(500).fetchImpl,
		);
		expect(await storedList()).toEqual([]);
		const next = resendFake();
		await runReadyEmail(production(), next.fetchImpl);
		expect(next.sent.map((mail) => mail.to)).toEqual([DANA]);
		expect(await storedList()).toEqual([DANA]);
	});

	it("keeps only the delivered address when one of two fails, and the next run sends only to the other", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, init?: RequestInit) => {
				const to = (JSON.parse(String(init?.body)) as Sent).to;
				return new Response("{}", { status: to === DANA ? 500 : 200 });
			},
		);
		await runReadyEmail(production(), fetchImpl);
		expect(await storedList()).toEqual([RILEY]);
		const next = resendFake();
		await runReadyEmail(production(), next.fetchImpl);
		expect(next.sent.map((mail) => mail.to)).toEqual([DANA]);
		expect(await storedList()).toEqual([RILEY, DANA]);
	});

	it("releases the address when Resend times out and no Cloudflare binding is set", async () => {
		await openHousehold();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const timedOut = vi.fn(async () => {
			throw new Error("timeout");
		});
		await runReadyEmail(production(), timedOut);
		expect(await storedList()).toEqual([]);
		expect(log).toHaveBeenCalledWith(
			"ready email: 0 sent, 1 failed (resend timeout or error)",
		);
		log.mockRestore();
	});
});

describe("the ready email: a try that Resend may have accepted never goes to Cloudflare's email (decision 146)", () => {
	const conflict = (name: string) =>
		vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ name, statusCode: 409 }), {
					status: 409,
				}),
		);

	it("falls back to Cloudflare's email on a 409 invalid_idempotent_request, since that key was used with other words and this email was never sent under it, and the address is reached", async () => {
		await openHousehold();
		const send = vi.fn(async (_message: Record<string, unknown>) => ({}));
		await runReadyEmail(
			production({ EMAIL: { send } }),
			conflict("invalid_idempotent_request"),
		);
		expect(send).toHaveBeenCalledOnce();
		expect(await storedList()).toEqual([DANA]);
	});

	it("releases the address on a timeout even with Cloudflare's email set, so no fallback sends and the next minute retries with the same key", async () => {
		await openHousehold();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const send = vi.fn(async (_message: Record<string, unknown>) => ({}));
			const timedOut = vi.fn(
				async (_url: RequestInfo | URL, _init?: RequestInit) => {
					throw new Error("timeout");
				},
			);
			await runReadyEmail(production({ EMAIL: { send } }), timedOut);
			expect(send).not.toHaveBeenCalled();
			expect(await storedList()).toEqual([]);
			expect(log).toHaveBeenCalledWith(
				"ready email: 0 sent, 1 failed (resend timeout or error)",
			);
			const next = resendFake();
			await runReadyEmail(production({ EMAIL: { send } }), next.fetchImpl);
			expect(next.keys).toEqual([await keyFor(DANA, firstMail(next.sent))]);
			expect(send).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});

	it("a retry with the same words is answered with Resend's record of the first send, so the email is not sent twice and Cloudflare's email sends nothing", async () => {
		await openHousehold();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const send = vi.fn(async (_message: Record<string, unknown>) => ({}));
			const first = vi.fn(
				async (_url: RequestInfo | URL, _init?: RequestInit) => {
					throw new Error("timeout");
				},
			);
			await runReadyEmail(production({ EMAIL: { send } }), first);
			const again = resendFake(200);
			await runReadyEmail(production({ EMAIL: { send } }), again.fetchImpl);
			expect(again.keys).toEqual([keyOf(first.mock.calls[0]?.[1])]);
			expect(send).not.toHaveBeenCalled();
			expect(await storedList()).toEqual([DANA]);
		} finally {
			log.mockRestore();
		}
	});

	it("tries again on a 409 concurrent_idempotent_requests: the first send may still fail, so nothing is kept reached and nothing is sent by Cloudflare", async () => {
		await openHousehold();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const send = vi.fn(async (_message: Record<string, unknown>) => ({}));
			await runReadyEmail(
				production({ EMAIL: { send } }),
				conflict("concurrent_idempotent_requests"),
			);
			expect(send).not.toHaveBeenCalled();
			expect(await storedList()).toEqual([]);
			expect(log).toHaveBeenCalledWith(
				"ready email: 0 sent, 1 failed (resend 409)",
			);
		} finally {
			log.mockRestore();
		}
	});
});

describe("the ready email: one Idempotency-Key per address and its words (Resend)", () => {
	const WORDS = renderReadyEmail(readLine([{ name: "Chase" }], 10));

	it("gives the email the key its address and words define, the same for every try", async () => {
		await openHousehold();
		const { fetchImpl, keys, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(keys).toEqual([await keyFor(DANA, firstMail(sent))]);
		expect(await readyEmailKey(DANA, firstMail(sent))).toBe(
			await keyFor(DANA, firstMail(sent)),
		);
	});

	it("changes the key when the read line changes, so a retry whose words changed is a new email", async () => {
		const changed = renderReadyEmail(readLine([{ name: "Chase" }], 11));
		expect(await readyEmailKey(DANA, WORDS)).not.toBe(
			await readyEmailKey(DANA, changed),
		);
		expect(await readyEmailKey(DANA, WORDS)).toBe(
			await readyEmailKey(
				DANA,
				renderReadyEmail(readLine([{ name: "Chase" }], 10)),
			),
		);
	});

	it("derives the key from the lower-cased address, so a capital letter sends the same key", async () => {
		expect(await readyEmailKey("Dana@Example.com", WORDS)).toBe(
			await readyEmailKey("dana@example.com", WORDS),
		);
		expect(await readyEmailKey(DANA, WORDS)).toMatch(
			/^ready-email-[0-9a-f]{64}$/,
		);
		expect((await readyEmailKey(DANA, WORDS)).length).toBe(76);
	});

	it("tries a timed-out send again next minute with the same key, so Resend answers the first send instead of sending twice", async () => {
		await openHousehold();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const timedOut = vi.fn(
				async (_url: RequestInfo | URL, _init?: RequestInit) => {
					throw new Error("timeout");
				},
			);
			await runReadyEmail(production(), timedOut);
			const next = resendFake();
			await runReadyEmail(production(), next.fetchImpl);
			expect(next.sent.map((mail) => mail.to)).toEqual([DANA]);
			const words = firstMail(next.sent);
			expect(keyOf(timedOut.mock.calls[0]?.[1])).toBe(
				await keyFor(DANA, words),
			);
			expect(next.keys).toEqual([await keyFor(DANA, words)]);
		} finally {
			log.mockRestore();
		}
	});
});

describe("the ready email: the words", () => {
	/**
	 * The text the email sends to one household, with `banks` connected in link order and `counts[i]` transactions on bank i.
	 * Each bank's history is in, so the questions are open.
	 */
	const readWords = async (
		banks: { id: number; name: string; disconnected?: boolean }[],
		counts: number[],
	) => {
		await clearHousehold();
		await writeRecord({ strokes: { bank: STROKE_ONE }, budgets: {} });
		await addMember(DANA);
		await saveAiSwitches(env.DB, { categories: false, income: false });
		for (const [index, bank] of banks.entries()) {
			const accountId = await addBank(bank.id, bank.name, {
				disconnected: bank.disconnected,
			});
			await addTransactions(accountId, counts[index] ?? 0);
		}
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		return sent[0]?.text ?? "";
	};

	it("names two banks, joined with and", async () => {
		const text = await readWords(
			[
				{ id: 1, name: "Chase" },
				{ id: 2, name: "American Express" },
			],
			[300, 198],
		);
		expect(text).toContain(
			"Tally has read your last 90 days from Chase and American Express and sorted all 498 transactions.",
		);
	});

	it("names three banks, with a comma and then and before the last", async () => {
		const text = await readWords(
			[
				{ id: 1, name: "Chase" },
				{ id: 2, name: "American Express" },
				{ id: 3, name: "Wells Fargo" },
			],
			[1, 1, 1],
		);
		expect(text).toContain(
			"from Chase, American Express and Wells Fargo and sorted all 3 transactions.",
		);
	});

	it("says from 4 banks with more than three names, the number being the connected banks", async () => {
		const text = await readWords(
			[
				{ id: 1, name: "Chase" },
				{ id: 2, name: "American Express" },
				{ id: 3, name: "Wells Fargo" },
				{ id: 4, name: "Capital One" },
			],
			[1, 1, 1, 1],
		);
		expect(text).toContain("from 4 banks and sorted all 4 transactions.");
	});

	it("names a bank once when two connected banks share its name", async () => {
		const text = await readWords(
			[
				{ id: 1, name: "Chase" },
				{ id: 2, name: "Chase" },
			],
			[1, 1],
		);
		expect(text).toContain("from Chase and sorted all 2 transactions.");
	});

	it("neither names nor counts a disconnected bank whose history is kept", async () => {
		const text = await readWords(
			[
				{ id: 1, name: "Chase" },
				{ id: 2, name: "American Express", disconnected: true },
			],
			[1, 5],
		);
		expect(text).toContain("from Chase and sorted 1 transaction.");
		expect(text).not.toContain("American Express");
	});

	it("counts with thousands commas", async () => {
		const text = await readWords([{ id: 1, name: "Chase" }], [1234]);
		expect(text).toContain("from Chase and sorted all 1,234 transactions.");
	});

	it("says one transaction in the singular", async () => {
		const text = await readWords([{ id: 1, name: "Chase" }], [1]);
		expect(text).toContain("from Chase and sorted 1 transaction.");
	});

	it("ends the sentence after the banks when there are no transactions", async () => {
		const text = await readWords([{ id: 1, name: "Chase" }], [0]);
		expect(text).toContain("Tally has read your last 90 days from Chase.");
		expect(text).not.toContain("sorted");
	});

	it("counts only the bank transactions: a manual entry and a split part are left out", async () => {
		const accountId = await openHousehold();
		await env.DB.prepare(
			"INSERT INTO transactions (plaid_transaction_id, account_id, date, amount_cents, raw_name) VALUES ('purchase', ?, '2026-10-01', -500, 'SHOP')",
		)
			.bind(accountId)
			.run();
		const parent = await env.DB.prepare(
			"SELECT id FROM transactions WHERE plaid_transaction_id = 'purchase'",
		).first<{ id: number }>();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name, parent_id) VALUES (?, '2026-10-01', -200, 'SHOP PART', ?)",
		)
			.bind(accountId, parent?.id)
			.run();
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, date, amount_cents, raw_name) VALUES (?, '2026-10-01', -300, 'CASH')",
		)
			.bind(accountId)
			.run();
		const { fetchImpl, sent } = resendFake();
		await runReadyEmail(production(), fetchImpl);
		expect(sent[0]?.text).toContain("from Chase and sorted 1 transaction.");
	});
});

describe("the ready email: the log", () => {
	it("logs one count line for a clean run, with no address, bank or count in it", async () => {
		await openHousehold();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runReadyEmail(production(), resendFake().fetchImpl);
		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith("ready email: 1 sent, 0 failed");
		log.mockRestore();
	});

	it("logs the provider kinds that failed, and never an address", async () => {
		await openHousehold({ members: [DANA, RILEY] });
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const email = {
			send: vi.fn(async () => {
				throw new Error("down");
			}),
		};
		await runReadyEmail(
			production({ EMAIL: email }),
			resendFake(500).fetchImpl,
		);
		expect(log).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"ready email: 0 sent, 2 failed (resend 500, email fallback error)",
		);
		const line = String(log.mock.calls[0]?.[0]);
		expect(line).not.toContain(DANA);
		expect(line).not.toContain(RILEY);
		log.mockRestore();
	});

	it("names no provider, when none is set up", async () => {
		await openHousehold();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		await runReadyEmail(
			production({ RESEND_API_KEY: undefined }),
			resendFake().fetchImpl,
		);
		expect(log).toHaveBeenCalledWith(
			"ready email: 0 sent, 1 failed (no provider configured)",
		);
		log.mockRestore();
	});
});

describe("the 10:00 run", () => {
	it("sends the ready email, after the reconnect reminders", async () => {
		await openHousehold();
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response("{}", { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchStub);
		await scheduledWith.scheduled(
			{ cron: "0 10 * * *" },
			{ ...env, DEMO: "false", RESEND_API_KEY: "test-key" },
		);
		expect(fetchStub).toHaveBeenCalledOnce();
		expect(JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body)).subject).toBe(
			SUBJECT,
		);
		vi.unstubAllGlobals();
	});

	it("still sends the ready email when the reconnect reminders fail, and logs only the error's name", async () => {
		await openHousehold();
		const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal("fetch", fetchStub);
		await scheduledWith.scheduled(
			{ cron: "0 10 * * *" },
			{
				...env,
				DB: failingOn("p.status = 'needs_attention'"),
				DEMO: "false",
				RESEND_API_KEY: "test-key",
			},
		);
		expect(fetchStub).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith("reconnect reminders failed Error");
		vi.unstubAllGlobals();
		log.mockRestore();
	});
});
