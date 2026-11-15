import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { daysBefore, householdTimeZone, todayIn } from "../dates";
import { readBankSignInEmails } from "../db/reconnect";
import { parseStoredWith } from "../db/stored-shape";
import { type DeliveryEnv, deliver, logDeliveries } from "./deliver";
import { renderReconnectEmail } from "./email";

const REMINDER_DAYS = 3;

/** How many people one bank's reminder is sent to at the same moment, so a slow answer for one no longer holds up the next. */
const REMINDERS_AT_ONCE = 3;

/**
 * The least time between the starts of two sends, in milliseconds, across every bank of a run: at most four a second
 * however fast the answers come. Resend allows a team ten requests a second, and a send past that is refused, and then
 * falls back or waits for the next three-day pass. Four leaves room for the one other sender that can run in the same
 * minute, the ready email (first-tally/ready-email.tsx), which goes to a new household's few people one at a time.
 */
export const REMINDER_PACE_MS = 250;

type ReminderEnv = DeliveryEnv & {
	DB: D1Database;
	DEMO?: string;
};

/**
 * The accounts a bank's reminder lists, as stored: each entry has a name and a mask (the SQL writes both, so the mask is a
 * string or null). Extra keys are allowed and stay on the entry.
 */
const StoredAccounts = Schema.mutable(
	Schema.Array(
		Schema.Struct({ name: Schema.String, mask: Schema.NullOr(Schema.String) }),
	),
);

/**
 * The accounts one bank's reminder lists, read as stored. An empty or null text is no accounts, as before. Null when the text
 * is not JSON or is not shaped like the accounts: the run skips that bank before it claims the bank's reminder (decision 233).
 */
export function accountsOf(text: string | null) {
	try {
		return parseStoredWith(StoredAccounts, text || "[]");
	} catch {
		return null;
	}
}

export function reconnectRecipients(db: D1Database) {
	return db
		.prepare(
			"SELECT email FROM household_members WHERE removed_at IS NULL AND last_seen_at >= datetime('now', '-90 days') ORDER BY email",
		)
		.all<{ email: string }>();
}

export async function runReconnectReminders(
	env: ReminderEnv,
	fetchImpl: typeof fetch = fetch,
	now: Date = new Date(),
	timeoutSignal: (milliseconds: number) => AbortSignal = AbortSignal.timeout,
	paceMs: number = REMINDER_PACE_MS,
) {
	if (env.DEMO === "true" || !(await readBankSignInEmails(env.DB))) return;
	const zone = await householdTimeZone(env.DB);
	const today = todayIn(zone, now);
	const cutoff = daysBefore(today, REMINDER_DAYS);

	const result =
		await env.DB.prepare(`SELECT p.id, p.institution_name, p.last_synced_at, p.reconnect_emailed_at,
		(SELECT json_group_array(json_object('name', a.name, 'mask', a.mask)) FROM accounts a WHERE a.plaid_item_id = p.id) AS accounts
		FROM plaid_items p WHERE p.status = 'needs_attention' AND p.disconnected_at IS NULL
		ORDER BY p.id`).all<{
			id: number;
			institution_name: string;
			last_synced_at: string | null;
			reconnect_emailed_at: string | null;
			accounts: string;
		}>();

	const banks = result.results.filter(
		(bank) =>
			bank.reconnect_emailed_at === null ||
			todayIn(
				zone,
				new Date(`${bank.reconnect_emailed_at.replace(" ", "T")}Z`),
			) <= cutoff,
	);

	if (!banks.length) {
		logDeliveries("reconnect reminders", 0, 0, new Set());

		return;
	}

	const recipients = await reconnectRecipients(env.DB);

	if (!recipients.results.length) {
		logDeliveries("reconnect reminders", 0, 0, new Set());

		return;
	}

	// Each send waits its turn to start: the pace after the moment the send before it really started, whichever bank it
	// is for. Counting from the real start, not a planned one, keeps two starts the pace apart even when a timer runs late.
	let lastStart: Promise<number> = Promise.resolve(Number.NEGATIVE_INFINITY);

	const paced = () => {
		lastStart = lastStart.then(async (startedAt) => {
			const wait = startedAt + paceMs - Date.now();

			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

			return Date.now();
		});

		return lastStart;
	};

	// Counts are per address and bank; the failure kinds name a provider status, never an address.
	let sentCount = 0;
	let failedCount = 0;
	const failureKinds = new Set<string>();

	for (const bank of banks) {
		// The stored accounts are read before the claim. A bank that cannot be read is not claimed and sends nothing: it is
		// counted once, and the next run tries it again (decision 233).
		const accounts = accountsOf(bank.accounts);

		if (accounts === null) {
			failedCount += 1;
			failureKinds.add("accounts unreadable");

			continue;
		}

		const claimedAt = now.toISOString().replace("T", " ").slice(0, 19);

		// A partial delivery keeps the claim; a failed recipient waits for the next three-day pass.
		const claim = await env.DB.prepare(
			"UPDATE plaid_items SET reconnect_emailed_at = ? WHERE id = ? AND reconnect_emailed_at IS ? AND status = 'needs_attention' AND disconnected_at IS NULL",
		)
			.bind(claimedAt, bank.id, bank.reconnect_emailed_at)
			.run();

		if (!claim.meta.changes) continue;

		const input = {
			bank: bank.institution_name,
			lastSyncedAt: bank.last_synced_at,
			accounts,
		};

		const email = renderReconnectEmail(input, zone);
		let sent = false;

		// `deliver` never throws: a failed send is an outcome. The outcomes come back in the recipients' order.
		const outcomes = await Effect.runPromise(
			Effect.forEach(
				recipients.results,
				({ email: recipient }) =>
					Effect.promise(async () => {
						await paced();

						return deliver(env, recipient, email, fetchImpl, timeoutSignal);
					}),
				{ concurrency: REMINDERS_AT_ONCE },
			),
		);

		for (const outcome of outcomes) {
			if (outcome.delivered) {
				sentCount += 1;
				sent = true;
			} else {
				failedCount += 1;

				for (const kind of outcome.kinds) failureKinds.add(kind);
			}
		}

		if (!sent)
			await env.DB.prepare(
				"UPDATE plaid_items SET reconnect_emailed_at = ? WHERE id = ? AND reconnect_emailed_at = ? AND status = 'needs_attention' AND disconnected_at IS NULL",
			)
				.bind(bank.reconnect_emailed_at, bank.id, claimedAt)
				.run();
	}

	logDeliveries("reconnect reminders", sentCount, failedCount, failureKinds);
}
