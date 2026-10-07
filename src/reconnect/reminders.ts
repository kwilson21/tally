import { daysBefore, householdTimeZone, todayIn } from "../dates";
import { readBankSignInEmails } from "../db/reconnect";
import { renderReconnectEmail } from "./email";

const REMINDER_DAYS = 3;
const FROM = "Tally <bank-sign-in@thesuperhuman.us>";

type ReminderEnv = {
	DB: D1Database;
	DEMO?: string;
	RESEND_API_KEY?: string;
	EMAIL?: {
		send(message: {
			to: string;
			from: string;
			subject: string;
			html: string;
			text: string;
		}): Promise<unknown>;
	};
};

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
	if (!banks.length) return;
	const recipients = await reconnectRecipients(env.DB);
	if (!recipients.results.length) return;
	for (const bank of banks) {
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
			accounts: JSON.parse(bank.accounts || "[]") as {
				name: string;
				mask: string | null;
			}[],
		};
		const email = renderReconnectEmail(input, zone);
		let sent = false;
		for (const { email: recipient } of recipients.results) {
			let delivered = false;
			if (env.RESEND_API_KEY) {
				const response = await fetchImpl("https://api.resend.com/emails", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${env.RESEND_API_KEY}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ from: FROM, to: recipient, ...email }),
				}).catch(() => null);
				delivered = response?.ok ?? false;
			}
			if (!delivered && env.EMAIL) {
				try {
					await env.EMAIL.send({ to: recipient, from: FROM, ...email });
					delivered = true;
				} catch {
					delivered = false;
				}
			}
			sent = sent || delivered;
		}
		if (!sent)
			await env.DB.prepare(
				"UPDATE plaid_items SET reconnect_emailed_at = ? WHERE id = ? AND reconnect_emailed_at = ? AND status = 'needs_attention' AND disconnected_at IS NULL",
			)
				.bind(bank.reconnect_emailed_at, bank.id, claimedAt)
				.run();
	}
}
